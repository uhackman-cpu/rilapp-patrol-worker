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
  const p = istParts(now), hour = Number(p.hour);
  const endDate = p.year + "-" + p.month + "-" + p.day;
  const start = new Date(Date.UTC(Number(p.year), Number(p.month)-1, Number(p.day)));
  if (hour < 23) start.setUTCDate(start.getUTCDate()-1);
  const startDate = [start.getUTCFullYear(),String(start.getUTCMonth()+1).padStart(2,"0"),String(start.getUTCDate()).padStart(2,"0")].join("-");
  const minute = Number(p.minute);
  return {active:hour>=23||hour<7||(hour===7&&minute<=15),startDate,endDate,startTime:"23:00",endTime:p.hour+":"+p.minute,stamp:startDate+" 23:00 – "+endDate+" "+p.hour+":"+p.minute+" IST"};
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
  return new URLSearchParams({
    fdate:win.startDate.split("-").reverse().join("/"),
    ftime:"23:00",
    tdate:win.endDate.split("-").reverse().join("/"),
    ttime:win.endTime,
    category:"-PM",
    Submit:"Update"
  });
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

function cleanAddress(value) {
  let addr=String(value??"").toUpperCase().trim();
  addr=addr.replace(/\/?C*H-?ALJN/g,"");
  addr=addr.replace(/OHEHECTOMETERPOST/g,"KM");
  addr=addr.replace(/CENTERLINEOFUNMANNEDLC/g,"फाटक");
  addr=addr.replace(/UNMANNEDLC/g,"फाटक");
  addr=addr.replace(/CENTERLINEOFLC/g,"फाटक");
  addr=addr.replace(/CENTERLINEOF/g,"").replace(/-/g,"");
  if(addr.startsWith("/"))addr=addr.slice(1);
  return addr.trim();
}
function cleanName(value) {
  const name=String(value??"");
  try{return name.split("/")[1].split("#")[0].replace(/RG/g,"").trim();}
  catch{return name;}
}
function getSortNumber(value) {
  const m=String(value??"").match(/\d+/);
  return m?Number(m[0]):9999;
}
function formatReportTime(value) {
  const raw=String(value??"").trim();
  const m=raw.match(/^\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}):\d{2}$/);
  return m?m[1]:raw;
}
function patrolData(html) {
  const {rows}=tableRows(html,"example");
  return rows.filter(c=>c.length>6&&String(c[4]??"").trim()).map(c=>({
    name:cleanName(c[1]),km:String(c[6]??"").trim(),
    time:formatReportTime(c[4]),addr:cleanAddress(c[5])
  })).sort((a,b)=>getSortNumber(a.name)-getSortNumber(b.name));
}
function batteryData(html) {
  const {rows}=tableRows(html,"pmTable"),low50=[],low35=[];
  for(const c of rows){
    if(c.length<=7)continue;
    const rawName=String(c[1]??"").trim(),battText=String(c[7]??"").trim();
    if(!rawName.includes("PM")&&!rawName.includes("P "))continue;
    const m=battText.match(/\d+/);if(!m)continue;
    const percent=Number(m[0]),name=cleanName(rawName);
    if(percent<=35)low35.push(name);else if(percent<=50)low50.push(name);
  }
  low50.sort((a,b)=>getSortNumber(a)-getSortNumber(b));
  low35.sort((a,b)=>getSortNumber(a)-getSortNumber(b));
  return {low50,low35};
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

  const patrol=patrolData(filteredReport);
  if(!patrol.length)return {skipped:true,reason:"no_patrol_records"};
  const batteryPage=await fetchWithJar(BATTERY_URL,{},jar);
  if(!batteryPage.ok)throw new Error("RILAPP battery page HTTP "+batteryPage.status);
  const battery=batteryData(await batteryPage.text());
  const startDate=win.startDate.split("-").reverse().join("/");
  const lines=["🌙 <b>Patrol Report</b> (Start: "+startDate+" 23:00)"];
  for(const item of patrol)lines.push("•"+item.name+" → "+item.km+" KM ("+item.time+") ["+item.addr+"]");
  const now=istParts();
  lines.push("","🕒 Update: "+now.hour+":"+now.minute+":"+now.second);
  if(battery.low50.length)lines.push("","⚠️ <b>बैटरी चेतावनी</b>\n"+battery.low50.join(",")+" की बैटरी 50% या उससे कम है कृपया चार्ज करें");
  if(battery.low35.length)lines.push("","⛔ <b>CRITICAL BATTERY</b>\n"+battery.low35.join(",")+" की बैटरी 35% या उससे कम है कृपया चार्ज करें");
  await sendTelegram(env,lines.join("\n"));
  console.log("RILAPP patrol report sent",{patrolRows:patrol.length,low50:battery.low50.length,low35:battery.low35.length,time:win.stamp});
  return {sent:true,patrolRows:patrol.length,low50:battery.low50.length,low35:battery.low35.length,time:win.stamp};


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