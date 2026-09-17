const dns = require("dns");
const express = require("express");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// Prefer IPv4 connections.
// This can prevent some cloud-hosting DNS/IPv6 connection issues.
dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIGURATION
// ============================================================

const PRC_BASE_URL =
  "https://prc.gov.ph";

const PRC_RESULTS_URL =
  `${PRC_BASE_URL}/articles/exam-results`;

const PRC_SCHEDULE_URL =
  `${PRC_BASE_URL}/2026-schedule-examination`;

// Check results every 2 minutes.
// This avoids unnecessarily hammering the PRC website.
const RESULTS_CHECK_INTERVAL =
  2 * 60 * 1000;

// Check schedule every 15 minutes.
const SCHEDULE_CHECK_INTERVAL =
  15 * 60 * 1000;

// Network timeout for each request.
const FETCH_TIMEOUT =
  20 * 1000;

// Number of attempts before reporting an error.
const FETCH_RETRIES = 3;

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

// ============================================================
// STATE
// ============================================================

let latestResults = [];
let upcomingExams = [];

let newlyDetectedResults = [];

let lastResultsCheck = null;
let nextResultsCheck = null;

let lastScheduleCheck = null;
let nextScheduleCheck = null;

let lastResultsError = null;
let lastScheduleError = null;

let resultsCheckRunning = false;
let scheduleCheckRunning = false;

// ============================================================
// STATE FILE
// ============================================================

function ensureDataDirectory() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
      recursive: true
    });
  }

  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          seenResults: []
        },
        null,
        2
      )
    );
  }
}

function loadState() {
  ensureDataDirectory();

  try {
    return JSON.parse(
      fs.readFileSync(
        STATE_FILE,
        "utf8"
      )
    );
  } catch (error) {
    console.error(
      "Could not read state file:",
      error.message
    );

    return {
      seenResults: []
    };
  }
}

function saveState(state) {
  ensureDataDirectory();

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      state,
      null,
      2
    )
  );
}

// ============================================================
// DATE HELPERS
// ============================================================

const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
};

function parseDateString(text) {
  if (!text) {
    return null;
  }

  const match = text.match(
    /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/
  );

  if (!match) {
    return null;
  }

  const month =
    MONTHS[
      match[1].toLowerCase()
    ];

  if (month === undefined) {
    return null;
  }

  const day =
    Number(match[2]);

  const year =
    Number(match[3]);

  return new Date(
    year,
    month,
    day,
    23,
    59,
    59,
    999
  );
}

// Parse target release date from PRC schedule.
function parseTargetReleaseDate(text) {
  return parseDateString(text);
}

// ============================================================
// EXAMINATION DATE PARSER
// ============================================================

function parseExamEndDate(text) {
  if (!text) {
    return null;
  }

  const clean = text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const yearMatch =
    clean.match(/(\d{4})/);

  if (!yearMatch) {
    return null;
  }

  const year =
    Number(yearMatch[1]);

  const monthRegex =
    /(January|February|March|April|May|June|July|August|September|October|November|December)/gi;

  const matches =
    [...clean.matchAll(monthRegex)];

  if (matches.length === 0) {
    return null;
  }

  // Use the last month mentioned.
  // Handles:
  // September 23 and 24, 2026
  // September 29, 30 and October 01, 2026
  const lastMonthMatch =
    matches[matches.length - 1];

  const monthName =
    lastMonthMatch[1].toLowerCase();

  const month =
    MONTHS[monthName];

  const afterMonth =
    clean.slice(
      lastMonthMatch.index +
        lastMonthMatch[0].length
    );

  const beforeYear =
    afterMonth.split(
      String(year)
    )[0];

  const dayMatches =
    beforeYear.match(/\d{1,2}/g);

  if (
    !dayMatches ||
    dayMatches.length === 0
  ) {
    return null;
  }

  const day =
    Number(
      dayMatches[
        dayMatches.length - 1
      ]
    );

  return new Date(
    year,
    month,
    day,
    23,
    59,
    59,
    999
  );
}

// ============================================================
// FORMAT DATE
// ============================================================

function formatDate(date) {
  if (
    !date ||
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date.toISOString();
}

// ============================================================
// CALCULATE RELEASE PROGRESS
// ============================================================

function calculateReleaseProgress(
  examStartDate,
  examEndDate,
  targetDate
) {
  const now = Date.now();

  const start =
    examStartDate
      ? examStartDate.getTime()
      : examEndDate
        ? examEndDate.getTime()
        : now;

  const end =
    targetDate
      ? targetDate.getTime()
      : now;

  let progress = 0;

  if (end <= start) {
    progress =
      now >= end
        ? 100
        : 0;
  } else if (now <= start) {
    progress = 0;
  } else if (now >= end) {
    progress = 100;
  } else {
    progress =
      ((now - start) /
        (end - start)) *
      100;
  }

  progress = Math.round(
    Math.min(
      100,
      Math.max(
        0,
        progress
      )
    )
  );

  const remainingMilliseconds =
    Math.max(
      0,
      end - now
    );

  const totalSeconds =
    Math.floor(
      remainingMilliseconds /
        1000
    );

  const days =
    Math.floor(
      totalSeconds /
        86400
    );

  const hours =
    Math.floor(
      (totalSeconds %
        86400) /
        3600
    );

  const minutes =
    Math.floor(
      (totalSeconds %
        3600) /
        60
    );

  const seconds =
    totalSeconds % 60;

  let status =
    "Processing";

  if (now < start) {
    status =
      "Exam Upcoming";
  } else if (now < end) {
    if (days > 0) {
      status =
        days === 1
          ? "Expected Tomorrow"
          : `${days} Days Remaining`;
    } else if (hours > 0) {
      status =
        `${hours} Hours Remaining`;
    } else {
      status =
        "Expected Soon";
    }
  } else {
    status =
      "Target Date Reached";
  }

  return {
    progress,
    remaining: {
      totalSeconds,
      days,
      hours,
      minutes,
      seconds
    },
    status
  };
}

// ============================================================
// NETWORK ERROR DETAILS
// ============================================================

function getErrorDetails(error) {
  const details = [];

  if (error?.name) {
    details.push(
      `name=${error.name}`
    );
  }

  if (error?.message) {
    details.push(
      `message=${error.message}`
    );
  }

  if (error?.code) {
    details.push(
      `code=${error.code}`
    );
  }

  if (error?.cause) {
    if (error.cause.code) {
      details.push(
        `cause.code=${error.cause.code}`
      );
    }

    if (error.cause.message) {
      details.push(
        `cause.message=${error.cause.message}`
      );
    }

    if (error.cause.errno) {
      details.push(
        `cause.errno=${error.cause.errno}`
      );
    }

    if (error.cause.syscall) {
      details.push(
        `cause.syscall=${error.cause.syscall}`
      );
    }

    if (error.cause.hostname) {
      details.push(
        `cause.hostname=${error.cause.hostname}`
      );
    }
  }

  return details.join(
    " | "
  );
}

// ============================================================
// FETCH HTML
// ============================================================

async function fetchHTML(url) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= FETCH_RETRIES;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(() => {
        controller.abort();
      }, FETCH_TIMEOUT);

    try {
      console.log(
        `[FETCH] Attempt ${attempt}/${FETCH_RETRIES}: ${url}`
      );

      const response =
        await fetch(url, {
          method: "GET",
          signal:
            controller.signal,
          redirect: "follow",

          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",

            "Accept":
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

            "Accept-Language":
              "en-US,en;q=0.9",

            "Cache-Control":
              "no-cache",

            "Pragma":
              "no-cache",

            "Referer":
              "https://prc.gov.ph/"
          }
        });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText}`
        );
      }

      const html =
        await response.text();

      if (
        !html ||
        html.length < 500
      ) {
        throw new Error(
          `PRC returned an unexpectedly small response (${html.length} bytes)`
        );
      }

      console.log(
        `[FETCH] Success: ${url} (${html.length} bytes)`
      );

      return html;
    } catch (error) {
      clearTimeout(timeout);

      lastError = error;

      console.error(
        `[FETCH] Failed attempt ${attempt}/${FETCH_RETRIES}: ${url}`
      );

      console.error(
        `[FETCH] ${getErrorDetails(error)}`
      );

      if (
        attempt < FETCH_RETRIES
      ) {
        const delay =
          attempt * 3000;

        console.log(
          `[FETCH] Retrying in ${delay / 1000}s...`
        );

        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              delay
            )
        );
      }
    }
  }

  throw new Error(
    `Unable to fetch ${url} after ${FETCH_RETRIES} attempts. ${getErrorDetails(lastError)}`
  );
}

// ============================================================
// PRC RESULTS PARSER
// ============================================================

function parseResultsPage(html) {
  const $ =
    cheerio.load(html);

  const results = [];

  $("a").each(
    (index, element) => {
      const link =
        $(element);

      const title =
        link
          .text()
          .replace(/\s+/g, " ")
          .trim();

      const href =
        link.attr("href");

      if (!title || !href) {
        return;
      }

      const lowerTitle =
        title.toLowerCase();

      const looksLikeResult =
        lowerTitle.includes(
          "result"
        ) ||
        lowerTitle.includes(
          "licensure examination"
        ) ||
        lowerTitle.includes(
          "licensure examinations"
        );

      if (!looksLikeResult) {
        return;
      }

      let url = href;

      if (
        url.startsWith("/")
      ) {
        url =
          PRC_BASE_URL +
          url;
      } else if (
        url.startsWith("./")
      ) {
        url =
          PRC_BASE_URL +
          "/" +
          url.substring(2);
      }

      if (
        !url.startsWith("http")
      ) {
        return;
      }

      results.push({
        title,
        url
      });
    }
  );

  // Remove duplicates.
  const unique = [];

  const seen =
    new Set();

  for (
    const item of results
  ) {
    if (
      seen.has(item.url)
    ) {
      continue;
    }

    seen.add(item.url);

    unique.push(item);
  }

  return unique.slice(
    0,
    30
  );
}

// ============================================================
// PRC RESULT ARTICLE DETAILS
// ============================================================

async function fetchResultDetails(
  item
) {
  try {
    const html =
      await fetchHTML(
        item.url
      );

    const $ =
      cheerio.load(html);

    const bodyText =
      $("body")
        .text()
        .replace(/\s+/g, " ")
        .trim();

    // Try to find posted date.
    let postedDate =
      null;

    const dateMatch =
      bodyText.match(
        /Posted on\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i
      );

    if (dateMatch) {
      const parsed =
        new Date(
          dateMatch[1]
        );

      if (
        !Number.isNaN(
          parsed.getTime()
        )
      ) {
        postedDate =
          parsed.toISOString();
      }
    }

    // Extract useful summary.
    let summary = "";

    const paragraphs =
      $("p")
        .map(
          (i, el) =>
            $(el)
              .text()
              .replace(
                /\s+/g,
                " "
              )
              .trim()
        )
        .get()
        .filter(Boolean);

    if (
      paragraphs.length > 0
    ) {
      summary =
        paragraphs
          .slice(0, 3)
          .join(" ");
    }

    return {
      ...item,
      postedDate,
      summary,
      source:
        "Professional Regulation Commission"
    };
  } catch (error) {
    console.error(
      "Could not fetch result article:",
      item.url
    );

    console.error(
      getErrorDetails(error)
    );

    return {
      ...item,
      postedDate: null,
      summary: "",
      source:
        "Professional Regulation Commission"
    };
  }
}

// ============================================================
// CHECK PRC RESULTS
// ============================================================

async function checkPRCResults() {
  if (
    resultsCheckRunning
  ) {
    return;
  }

  resultsCheckRunning =
    true;

  try {
    console.log(
      `[RESULTS] Checking PRC results at ${new Date().toLocaleString()}`
    );

    const html =
      await fetchHTML(
        PRC_RESULTS_URL
      );

    const parsed =
      parseResultsPage(
        html
      );

    if (
      parsed.length === 0
    ) {
      throw new Error(
        "No result announcements were found on the PRC page."
      );
    }

    const state =
      loadState();

    if (
      !Array.isArray(
        state.seenResults
      )
    ) {
      state.seenResults =
        [];
    }

    const existingSeen =
      new Set(
        state.seenResults
      );

    const isFirstRun =
      state.seenResults
        .length === 0;

    const detectedNew =
      [];

    const enrichedResults =
      [];

    for (
      const item of parsed.slice(
        0,
        20
      )
    ) {
      let detailed =
        null;

      // Only fetch article pages
      // when necessary.
      if (
        !latestResults.some(
          result =>
            result.url ===
            item.url
        )
      ) {
        detailed =
          await fetchResultDetails(
            item
          );
      }

      const result =
        detailed || {
          ...item,
          source:
            "Professional Regulation Commission"
        };

      enrichedResults.push(
        result
      );

      if (
        !existingSeen.has(
          item.url
        ) &&
        !isFirstRun
      ) {
        detectedNew.push(
          result
        );
      }
    }

    // Preserve previous cached results
    // when possible.
    const merged = [];

    for (
      const item of
        enrichedResults
    ) {
      const existing =
        latestResults.find(
          result =>
            result.url ===
            item.url
        );

      merged.push(
        existing
          ? {
              ...existing,
              ...item
            }
          : item
      );
    }

    latestResults =
      merged
        .sort(
          (a, b) => {
            const dateA =
              a.postedDate
                ? new Date(
                    a.postedDate
                  ).getTime()
                : 0;

            const dateB =
              b.postedDate
                ? new Date(
                    b.postedDate
                  ).getTime()
                : 0;

            return (
              dateB - dateA
            );
          }
        )
        .slice(0, 30);

    newlyDetectedResults =
      detectedNew;

    // Save URLs as seen.
    const allSeen = [
      ...state.seenResults,
      ...parsed.map(
        item => item.url
      )
    ];

    state.seenResults = [
      ...new Set(allSeen)
    ].slice(-200);

    saveState(state);

    lastResultsError =
      null;

    console.log(
      `[RESULTS] Found ${parsed.length} PRC result announcements.`
    );

    if (
      detectedNew.length > 0
    ) {
      console.log(
        `[RESULTS] NEW RESULTS: ${detectedNew.length}`
      );
    }
  } catch (error) {
    lastResultsError =
      getErrorDetails(error);

    console.error(
      "[RESULTS] Error:",
      getErrorDetails(error)
    );
  } finally {
    lastResultsCheck =
      new Date().toISOString();

    nextResultsCheck =
      new Date(
        Date.now() +
          RESULTS_CHECK_INTERVAL
      ).toISOString();

    resultsCheckRunning =
      false;
  }
}

// ============================================================
// PRC SCHEDULE PARSER
// ============================================================

function parseSchedulePage(html) {
  const $ =
    cheerio.load(html);

  const exams = [];

  $("table tr").each(
    (index, row) => {
      const cells =
        $(row)
          .find("td, th")
          .map(
            (i, cell) =>
              $(cell)
                .text()
                .replace(
                  /\u00a0/g,
                  " "
                )
                .replace(
                  /\s+/g,
                  " "
                )
                .trim()
          )
          .get();

      if (
        cells.length < 7
      ) {
        return;
      }

      // PRC table normally has:
      // SEQ
      // NAME
      // EXAM DATE
      // DAYS
      // TESTING CENTERS
      // APPLICATION OPENING
      // APPLICATION DEADLINE
      // TARGET RESULT DATE

      const sequence =
        cells[0];

      const name =
        cells[1];

      const examDatesText =
        cells[2];

      const targetReleaseText =
        cells[
          cells.length - 2
        ];

      if (
        !name ||
        !examDatesText ||
        !targetReleaseText
      ) {
        return;
      }

      const targetDate =
        parseTargetReleaseDate(
          targetReleaseText
        );

      if (!targetDate) {
        return;
      }

      const examEndDate =
        parseExamEndDate(
          examDatesText
        );

      exams.push({
        sequence,
        name,
        examDates:
          examDatesText,
        targetReleaseDate:
          formatDate(
            targetDate
          ),
        examEndDate:
          formatDate(
            examEndDate
          )
      });
    }
  );

  // Remove duplicates.
  const unique = [];

  const seen =
    new Set();

  for (
    const exam of exams
  ) {
    const key =
      `${exam.name}|${exam.targetReleaseDate}`;

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    unique.push(exam);
  }

  return unique;
}

// ============================================================
// CHECK PRC SCHEDULE
// ============================================================

async function checkPRCSchedule() {
  if (
    scheduleCheckRunning
  ) {
    return;
  }

  scheduleCheckRunning =
    true;

  try {
    console.log(
      `[SCHEDULE] Checking PRC schedule at ${new Date().toLocaleString()}`
    );

    const html =
      await fetchHTML(
        PRC_SCHEDULE_URL
      );

    const parsed =
      parseSchedulePage(
        html
      );

    if (
      parsed.length === 0
    ) {
      throw new Error(
        "No examination schedule records were found."
      );
    }

    upcomingExams =
      parsed;

    lastScheduleError =
      null;

    console.log(
      `[SCHEDULE] Loaded ${parsed.length} PRC examination schedule records.`
    );
  } catch (error) {
    lastScheduleError =
      getErrorDetails(error);

    console.error(
      "[SCHEDULE] Error:",
      getErrorDetails(error)
    );
  } finally {
    lastScheduleCheck =
      new Date().toISOString();

    nextScheduleCheck =
      new Date(
        Date.now() +
          SCHEDULE_CHECK_INTERVAL
      ).toISOString();

    scheduleCheckRunning =
      false;
  }
}

// ============================================================
// FIND NEXT EXPECTED RESULT
// ============================================================

function getNextExpectedResult() {
  if (
    !Array.isArray(
      upcomingExams
    )
  ) {
    return null;
  }

  const now =
    Date.now();

  const publishedTitles =
    latestResults.map(
      result =>
        result.title
          .toLowerCase()
          .replace(
            /\s+/g,
            " "
          )
    );

  const candidates = [];

  for (
    const exam of upcomingExams
  ) {
    if (
      !exam.targetReleaseDate
    ) {
      continue;
    }

    const targetDate =
      new Date(
        exam.targetReleaseDate
      );

    if (
      Number.isNaN(
        targetDate.getTime()
      )
    ) {
      continue;
    }

    // Ignore records whose target release
    // is already far in the past.
    if (
      targetDate.getTime() <
      now -
        24 *
          60 *
          60 *
          1000
    ) {
      continue;
    }

    const examName =
      exam.name
        .toLowerCase()
        .replace(
          /\s+/g,
          " "
        );

    // Check whether an actual result
    // announcement already exists.
    const alreadyPublished =
      publishedTitles.some(
        title => {
          const importantWords =
            examName
              .split(/\s+/)
              .filter(
                word =>
                  word.length > 4
              );

          if (
            importantWords.length ===
            0
          ) {
            return false;
          }

          const matches =
            importantWords.filter(
              word =>
                title.includes(
                  word
                )
            ).length;

          return (
            matches >=
            Math.min(
              2,
              importantWords.length
            )
          );
        }
      );

    if (
      alreadyPublished
    ) {
      continue;
    }

    const examEndDate =
      exam.examEndDate
        ? new Date(
            exam.examEndDate
          )
        : null;

    const progress =
      calculateReleaseProgress(
        null,
        examEndDate,
        targetDate
      );

    candidates.push({
      ...exam,
      progress:
        progress.progress,
      status:
        progress.status,
      remaining:
        progress.remaining
    });
  }

  candidates.sort(
    (a, b) =>
      new Date(
        a.targetReleaseDate
      ) -
      new Date(
        b.targetReleaseDate
      )
  );

  return candidates.length >
    0
    ? candidates[0]
    : null;
}

// ============================================================
// EXPRESS MIDDLEWARE
// ============================================================

app.use(
  express.json()
);

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

// ============================================================
// DASHBOARD API
// ============================================================

app.get(
  "/api/dashboard",
  (req, res) => {
    const nextExpectedResult =
      getNextExpectedResult();

    res.json({
      success: true,

      results:
        latestResults,

      upcoming:
        upcomingExams,

      nextExpectedResult,

      newResults:
        newlyDetectedResults,

      checkedAt:
        lastResultsCheck,

      nextResultsCheck:
        nextResultsCheck,

      scheduleCheckedAt:
        lastScheduleCheck,

      nextScheduleCheck:
        nextScheduleCheck,

      resultsError:
        lastResultsError,

      scheduleError:
        lastScheduleError,

      resultsInterval:
        RESULTS_CHECK_INTERVAL,

      scheduleInterval:
        SCHEDULE_CHECK_INTERVAL,

      sources: {
        results:
          PRC_RESULTS_URL,

        schedule:
          PRC_SCHEDULE_URL
      }
    });
  }
);

// ============================================================
// MANUAL CHECK
// ============================================================

app.post(
  "/api/check",
  async (req, res) => {
    try {
      await checkPRCResults();

      await checkPRCSchedule();

      res.json({
        success: true,

        message:
          "PRC results and schedule checked.",

        nextExpectedResult:
          getNextExpectedResult()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          getErrorDetails(
            error
          )
      });
    }
  }
);

// ============================================================
// CLEAR NEW RESULTS
// ============================================================

app.post(
  "/api/clear-new",
  (req, res) => {
    newlyDetectedResults =
      [];

    res.json({
      success: true
    });
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      status: "ok",

      time:
        new Date().toISOString(),

      resultsCheckRunning,

      scheduleCheckRunning,

      lastResultsCheck,

      nextResultsCheck,

      lastScheduleCheck,

      nextScheduleCheck
    });
  }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  async () => {
    console.log("");

    console.log(
      "=============================================="
    );

    console.log(
      "        PRC ALERT MONITOR STARTED"
    );

    console.log(
      "=============================================="
    );

    console.log(
      `Dashboard: http://localhost:${PORT}`
    );

    console.log(
      `PRC Results: ${PRC_RESULTS_URL}`
    );

    console.log(
      `PRC Schedule: ${PRC_SCHEDULE_URL}`
    );

    console.log(
      `Results interval: ${RESULTS_CHECK_INTERVAL / 1000}s`
    );

    console.log(
      `Schedule interval: ${SCHEDULE_CHECK_INTERVAL / 60000}min`
    );

    console.log(
      `Fetch timeout: ${FETCH_TIMEOUT / 1000}s`
    );

    console.log(
      `Fetch retries: ${FETCH_RETRIES}`
    );

    console.log(
      "=============================================="
    );

    console.log("");

    // ========================================================
    // INITIAL CHECKS
    // ========================================================

    await checkPRCSchedule();

    await checkPRCResults();

    // ========================================================
    // RESULT CHECK LOOP
    // ========================================================

    async function resultCheckLoop() {
      await checkPRCResults();

      setTimeout(
        resultCheckLoop,
        RESULTS_CHECK_INTERVAL
      );
    }

    // ========================================================
    // SCHEDULE CHECK LOOP
    // ========================================================

    async function scheduleCheckLoop() {
      await checkPRCSchedule();

      setTimeout(
        scheduleCheckLoop,
        SCHEDULE_CHECK_INTERVAL
      );
    }

    setTimeout(
      resultCheckLoop,
      RESULTS_CHECK_INTERVAL
    );

    setTimeout(
      scheduleCheckLoop,
      SCHEDULE_CHECK_INTERVAL
    );
  }
);