const LOGIN_URL = "https://ip3.rilapp.com/railways/login.php";
const REPORT_URL = "https://ip3.rilapp.com/railways/patrollingReport.php";
const BATTERY_URL = "https://ip3.rilapp.com/railways/dashboard_deviceListOnly.php";
const TZ = "Asia/Kolkata";

const json = (value, status = 200) =>
  new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function istParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
}

function shiftWindow(now = new Date()) {
  const p = istParts(now);
  const hour = Number(p.hour);
  const endDate = `${p.year}-${p.month}-${p.day}`;
  const start = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  if (hour < 7 || (hour === 7 && Number(p.minute) <= 15)) start.setUTCDate(start.getUTCDate() - 1);
  const startDate = [
    start.getUTCFullYear(),
    String(start.getUTCMonth() + 1).padStart(2, "0"),
    String(start.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const minute = Number(p.minute);
  const inMorningWindow = hour < 7 || (hour === 7 && minute <= 15);
  return {
    active: hour >= 23 || inMorningWindow,
    startDate,
    endDate,
    startTime: "23:00",
    endTime: "07:15",
    stamp: `${startDate} 23:00 – ${endDate} 07:15 IST`,
  };
}

function decodeHtml(s) {
  return String(s ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function cellText(html) {
  return decodeHtml(
    String(html)
      .replace(/<br\s*\/?\s*>/gi, " / ")
      .replace(/<\/(?:div|p|li)>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/[\t\r\n]+/g, " ")
      .replace(/\s{2,}/g, " ")
  ).trim();
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[m[1].toLowerCase()] = decodeHtml(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function formDetails(html, pageUrl) {
  const fm = html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!fm) return null;
  const a = attrs(fm[1]);
  const fields = new URLSearchParams();
  for (const m of fm[2].matchAll(/<input\b[^>]*>/gi)) {
    const x = attrs(m[0]);
    if (x.name && !["submit", "button", "file", "checkbox", "radio"].includes((x.type || "").toLowerCase())) {
      fields.set(x.name, x.value || "");
    }
  }
  for (const m of fm[2].matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const x = attrs(m[1]);
    if (!x.name) continue;
    const opts = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
    const selected = opts.find(o => /\bselected\b/i.test(o[1])) || opts[0];
    if (selected) {
      const oa = attrs(selected[1]);
      fields.set(x.name, oa.value ?? cellText(selected[2]));
    }
  }
  return {
    url: new URL(a.action || pageUrl, pageUrl).toString(),
    method: (a.method || "GET").toUpperCase(),
    fields,
  };
}

function applyReportFilters(form, win) {
  const p = form.fields;
  let startFound = false;
  let endFound = false;
  for (const name of [...p.keys()]) {
    const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (n === "category") p.set(name, "-PM");
    if (n === "submit") p.set(name, "Update");

    if (/start|from|begin/.test(n)) {
      if (/time/.test(n)) p.set(name, win.startTime);
      else if (/date/.test(n)) p.set(name, win.startDate);
      else p.set(name, `${win.startDate} 23:00`);
      startFound = true;
    }
    if (/end|to|upto|through/.test(n)) {
      if (/time/.test(n)) p.set(name, win.endTime);
      else if (/date/.test(n)) p.set(name, win.endDate);
      else p.set(name, `${win.endDate} ${win.endTime}`);
      endFound = true;
    }
  }
  // Known RILAPP filter values. The form's own named controls take precedence.
  if (!p.has("category")) p.set("category", "-PM");
  if (!p.has("Submit")) p.set("Submit", "Update");
  if (!startFound) p.set("start_time", win.startTime);
  if (!endFound) p.set("end_time", win.endTime);
  return p;
}

function tableRows(html, tableId) {
  const table = new RegExp(`<table\\b(?=[^>]*\\bid=["']${tableId}["'])[^>]*>([\\s\\S]*?)<\\/table>`, "i").exec(html);
  if (!table) return { headers: [], rows: [] };
  const body = table[1];
  const headHtml = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(body)?.[1] || "";
  const headerRow = /<tr\b[^>]*>([\s\S]*?)<\/tr>/i.exec(headHtml)?.[1] || "";
  const headers = [...headerRow.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m => cellText(m[1]));
  const tbody = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(body)?.[1] || body;
  const rows = [...tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(m => [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => cellText(c[1])))
    .filter(cells => cells.length && cells.some(Boolean));
  return { headers, rows };
}

function headerIndex(headers, patterns, fallback) {
  const i = headers.findIndex(h => patterns.some(p => p.test(h)));
  return i >= 0 ? i : fallback;
}

function patrolData(html) {
  const { headers, rows } = tableRows(html, "example");
  const ni = headerIndex(headers, [/name|employee|patroller|staff/i], 1);
  const ti = headerIndex(headers, [/time|date/i], 2);
  const ai = headerIndex(headers, [/address|location|place|gps/i], 3);
  const ki = headerIndex(headers, [/\bkm\b|kilomet|distance/i], Math.max(0, headers.length - 1));
  const parsed = rows.map(c => {
    const raw = c.join(" ");
    const p = raw.match(/\bP\s*0?([1-9]|1\d|2[01])\b/i);
    const distanceText = [c[ki] || "", raw].join(" | ");
    const distancePatterns = [
      /(?:KM\s*Run|Run\s*KM|History\s*Distance|Distance|Total\s*KM)\s*[:=-]?\s*(\d+(?:[.,]\d+)?)/i,
      /(\d+(?:[.,]\d+)?)\s*(?:KM|Kms|Kilometers?)\b/i,
    ];
    let distance = null;
    for (const re of distancePatterns) {
      const match = distanceText.match(re);
      if (match) { distance = Number(match[1].replace(",", ".")); break; }
    }
    if (distance === null && /^\d+(?:[.,]\d+)?$/.test(String(c[ki] || "").trim())) {
      distance = Number(String(c[ki]).replace(",", "."));
    }
    const timeMatch = raw.match(/\\b([01]?\\d|2[0-3]):[0-5]\\d\\b/);
    const codeMatch = raw.match(/\\bKM\\d+\\/\\d+\\b/i);
    return {
      patrol: p ? `P${Number(p[1])}` : "",
      time: timeMatch ? timeMatch[0].padStart(5, "0") : "",
      code: codeMatch ? codeMatch[0] : "",
      km: distance,
    };
  });
  parsed.sort((a, b) => {
    const an = Number((a.patrol.match(/\d+/) || [999])[0]);
    const bn = Number((b.patrol.match(/\d+/) || [999])[0]);
    return an - bn;
  });
  return { headers, rows: parsed };
}

function batteryData(html) {
  const { headers, rows } = tableRows(html, "pmTable");
  const bi = headerIndex(headers, [/battery|charge|percent|level/i], -1);
  const ni = headerIndex(headers, [/name|device|employee|staff/i], 0);
  const parsed = rows.map(c => {
    const candidates = bi >= 0 ? [c[bi], ...c] : c;
    const found = candidates.map(x => String(x).match(/(\d{1,3})\s*%/)).find(Boolean);
    const pct = found ? Number(found[1]) : null;
    return { name: c[ni] || "Device", percent: pct, text: c.join(" | ") };
  }).filter(x => x.percent !== null && x.percent <= 50);
  parsed.sort((a, b) => a.percent - b.percent);
  return parsed;
}

function splitMessage(text, max = 3800) {
  const out = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > max && current) {
      out.push(current);
      current = line;
    } else current += (current ? "\n" : "") + line;
  }
  if (current) out.push(current);
  return out;
}

async function sendTelegram(env, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  for (const part of splitMessage(text)) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: part, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(`Telegram send failed: HTTP ${r.status}`);
  }
}

function updateCookieJar(response, jar) {
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get("set-cookie") || ""];
  for (const item of setCookies) {
    const pair = item.split(";")[0].trim();
    if (!pair) continue;
    const key = pair.split("=")[0];
    jar.set(key, pair);
  }
}

async function fetchWithJar(url, init, jar) {
  let target = url;
  let method = init?.method || "GET";
  let body = init?.body;
  let headers = new Headers(init?.headers || {});
  for (let i = 0; i < 6; i++) {
    if (jar.size) headers.set("cookie", [...jar.values()].join("; "));
    const r = await fetch(target, { method, body, headers, redirect: "manual" });
    updateCookieJar(r, jar);
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get("location");
      if (!loc) return r;
      target = new URL(loc, target).toString();
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
      }
      continue;
    }
    return r;
  }
  throw new Error("Too many redirects from RILAPP");
}

async function runMonitor(env) {
  const missing = ["RILAPP_USERNAME", "RILAPP_PASSWORD", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].filter(k => !env[k]);
  if (missing.length) {
    console.log("Monitor not configured; missing secrets:", missing.join(", "));
    return { skipped: true, missing };
  }
  const win = shiftWindow();
  if (!win.active) {
    console.log("Outside IST patrol window:", win.stamp);
    return { skipped: true, reason: "outside_window", time: win.stamp };
  }

  const jar = new Map();
  const loginPage = await fetchWithJar(LOGIN_URL, {}, jar);
  if (!loginPage.ok) throw new Error(`RILAPP login page HTTP ${loginPage.status}`);
  const loginForm = new URLSearchParams({
    username: env.RILAPP_USERNAME,
    password: env.RILAPP_PASSWORD,
  });
  const login = await fetchWithJar(LOGIN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: loginForm.toString(),
  }, jar);
  if (!login.ok) throw new Error(`RILAPP login HTTP ${login.status}`);
  const loginHtml = await login.text();
  if (/name=["']password["']|id=["']password["']/i.test(loginHtml) && /sign\s*in/i.test(loginHtml)) {
    throw new Error("RILAPP login rejected or session not established");
  }

  const reportPage = await fetchWithJar(REPORT_URL, {}, jar);
  if (!reportPage.ok) throw new Error(`RILAPP report page HTTP ${reportPage.status}`);
  const reportHtml = await reportPage.text();
  const form = formDetails(reportHtml, REPORT_URL);
  let filteredReport = reportHtml;
  if (form) {
    const params = applyReportFilters(form, win);
    const response = form.method === "GET"
      ? await fetchWithJar(`${form.url}?${params.toString()}`, {}, jar)
      : await fetchWithJar(form.url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        }, jar);
    if (response.ok) filteredReport = await response.text();
  }

  const patrol = patrolData(filteredReport);
  const batteryPage = await fetchWithJar(BATTERY_URL, {}, jar);
  if (!batteryPage.ok) throw new Error(`RILAPP battery page HTTP ${batteryPage.status}`);
  const batteryHtml = await batteryPage.text();
  const lowBatteries = batteryData(batteryHtml);

  const validDistances = patrol.rows.filter(row => Number.isFinite(row.km));
  const totalDistance = validDistances.reduce((sum, row) => sum + row.km, 0);
  const startDate = win.startDate.split("-").reverse().join("/");
  const lines = [`🌙 <b>Patrol Report</b> (Start: ${startDate} 23:00)`, ""];
  for (const row of validDistances) {
    const number = Number((row.patrol.match(/\\d+/) || [0])[0]);
    const timePart = row.time ? ` (${row.time})` : "";
    const codePart = row.code ? ` [${row.code}]` : "";
    lines.push(`•P ${number} → ${row.km} KM${timePart}${codePart}`, "");
  }
  const now = istParts();
  lines.push(`🕒 Update: ${now.hour}:${now.minute}:${now.second}`, "");
  lines.push(`📏 <b>Total Distance: ${totalDistance.toFixed(2)} KM</b>`);
  lines.push(`Distance records: ${validDistances.length}/${patrol.rows.length}`, "");
  lines.push("⚠️ <b>बैटरी चेतावनी</b>");
  if (!lowBatteries.length) {
    lines.push("कोई डिवाइस बैटरी 50% या उससे कम नहीं है।");
  } else {
    for (const item of lowBatteries) {
      const level = item.percent <= 35 ? "⛔ CRITICAL" : "⚠️ WARNING";
      lines.push(`${level} | ${item.name} | ${item.percent}%`);
    }
  }
  const message = lines.join("\n");
  await sendTelegram(env, message);
  console.log("RILAPP patrol report sent", { patrolRows: patrol.rows.length, lowBatteries: lowBatteries.length, time: win.stamp });
  return { sent: true, patrolRows: patrol.rows.length, distanceRecords: validDistances.length, totalDistanceKm: totalDistance, lowBatteries: lowBatteries.length, time: win.stamp };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({
        ok: true,
        worker: "rilapp-patrol-telegram",
        timezone: TZ,
        patrolWindow: "23:00-07:15",
        cronExpected: "*/2 * * * *",
        secretsConfigured: ["RILAPP_USERNAME", "RILAPP_PASSWORD", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].every(k => Boolean(env[k])),
      });
    }
    if (url.pathname === "/run") {
      if (!env.CONTROL_TOKEN || request.headers.get("authorization") !== `Bearer ${env.CONTROL_TOKEN}`) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }
      try {
        return json({ ok: true, result: await runMonitor(env) });
      } catch (error) {
        console.error("Manual run failed:", error?.message || String(error));
        return json({ ok: false, error: error?.message || "Run failed" }, 500);
      }
    }
    return new Response("RILAPP patrol monitor is installed. Check /health.", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await runMonitor(env);
      } catch (firstError) {
        console.error("Scheduled RILAPP monitor failed; retrying in 60 seconds:", firstError?.message || String(firstError));
        await new Promise(resolve => setTimeout(resolve, 60_000));
        try {
          await runMonitor(env);
        } catch (retryError) {
          console.error("Scheduled RILAPP retry failed:", retryError?.message || String(retryError));
        }
      }
    })());
  },
};