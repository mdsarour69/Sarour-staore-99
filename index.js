import express from "express";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { Pool } from "pg";

const BOT_TOKEN = String(process.env.BOT_TOKEN || "").trim();
const SUPPLIER_API_KEY = String(process.env.SUPPLIER_API_KEY || "").trim();
const OWNER_ID = Number(process.env.OWNER_ID || "8179643564");
const SUPPORT_USERNAME = String(process.env.SUPPORT_USERNAME || "@Sarour99").trim();
const GROUP_USERNAME = String(process.env.GROUP_USERNAME || "@sarourstore").trim();
const CHANNEL_USERNAME = String(process.env.CHANNEL_USERNAME || "@sarourstors").trim();

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_URL = String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
const DATA_DIR = String(process.env.DATA_DIR || "./data");
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

const DEFAULT_USD_TO_BDT = Number(process.env.USD_TO_BDT || "120");
const DEFAULT_MARKUP_BDT = Number(process.env.PROFIT_MARKUP_BDT || "50");
const DEFAULT_REFERRAL_REWARD_BDT = Number(process.env.REFERRAL_REWARD_BDT || "0");
const DEFAULT_MIN_DEPOSIT_BDT = Number(process.env.MIN_DEPOSIT_BDT || "50");
const DEFAULT_DEPOSIT_METHOD = String(process.env.DEPOSIT_METHOD || "Manual Payment").trim();
const DEFAULT_DEPOSIT_ACCOUNT = String(process.env.DEPOSIT_ACCOUNT || "").trim();
const AUTO_SYNC_MINUTES = Math.max(5, Number(process.env.AUTO_SYNC_MINUTES || "15"));

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SUPPLIER_API = "https://api-esb.eklas.dev/v1";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing.");
  process.exit(1);
}

const WEBHOOK_SECRET =
  String(process.env.WEBHOOK_SECRET || "").trim() ||
  crypto.createHash("sha256").update(BOT_TOKEN).digest("hex").slice(0, 40);

const WEBHOOK_PATH = `/telegram/webhook/${WEBHOOK_SECRET}`;

const defaults = () => ({
  version: 1,
  users: {},
  products: [],
  localProducts: [],
  orders: [],
  deposits: [],
  sessions: {},
  settings: {
    storeName: "Sarour Store",
    usdToBdt: DEFAULT_USD_TO_BDT,
    markupBdt: DEFAULT_MARKUP_BDT,
    referralRewardBdt: DEFAULT_REFERRAL_REWARD_BDT,
    minDepositBdt: DEFAULT_MIN_DEPOSIT_BDT,
    depositMethod: DEFAULT_DEPOSIT_METHOD,
    depositAccount: DEFAULT_DEPOSIT_ACCOUNT,
    depositInstructions: "Pay first, then submit the transaction/reference ID.",
    depositsEnabled: true,
    autoOrderEnabled: true,
    extraOwnerId: 0,
    syncedAt: ""
  }
});

let state = defaults();
let botUsername = "";
let saveQueue = Promise.resolve();

function ensureShape(data) {
  const d = data && typeof data === "object" ? data : {};
  const base = defaults();
  return {
    ...base,
    ...d,
    users: d.users && typeof d.users === "object" ? d.users : {},
    products: Array.isArray(d.products) ? d.products : [],
    localProducts: Array.isArray(d.localProducts) ? d.localProducts : [],
    orders: Array.isArray(d.orders) ? d.orders : [],
    deposits: Array.isArray(d.deposits) ? d.deposits : [],
    sessions: d.sessions && typeof d.sessions === "object" ? d.sessions : {},
    settings: { ...base.settings, ...(d.settings || {}) }
  };
}

const storage = {
  pool: null,
  filePath: path.join(DATA_DIR, "store.json"),

  async init() {
    if (DATABASE_URL) {
      this.pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }
      });
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS sarour_store_state (
          id INTEGER PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const row = await this.pool.query("SELECT data FROM sarour_store_state WHERE id = 1");
      if (row.rows[0]?.data) state = ensureShape(row.rows[0].data);
      else await this.save(defaults());
      console.log("Storage: PostgreSQL");
      return;
    }

    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      state = ensureShape(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch {
      state = defaults();
      await this.save(state);
    }
    console.log(`Storage: JSON file (${this.filePath})`);
  },

  async save(data) {
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO sarour_store_state(id, data, updated_at)
         VALUES(1, $1::jsonb, NOW())
         ON CONFLICT(id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [JSON.stringify(data)]
      );
      return;
    }
    await fs.mkdir(DATA_DIR, { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
};

async function persist() {
  saveQueue = saveQueue.then(() => storage.save(state)).catch(err => {
    console.error("Save error:", err);
  });
  return saveQueue;
}

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function wl(v) {
  return String(v ?? "").replace(/eklas/gi, "Sarour Store");
}

function cleanUsername(v) {
  return String(v || "").replace(/^@/, "").trim();
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function moneyBdt(n) {
  return `৳${Math.round(Number(n) || 0)}`;
}

function btn(text, style) {
  const b = { text: String(text).slice(0, 64) };
  if (style) b.style = style;
  return b;
}

function keyboard(rows, placeholder = "Choose an option") {
  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: placeholder
  };
}

function isOwner(uid) {
  return Number(uid) === OWNER_ID ||
    (Number(state.settings.extraOwnerId || 0) > 0 &&
      Number(uid) === Number(state.settings.extraOwnerId));
}

function userRecord(from) {
  const uid = String(from.id);
  if (!state.users[uid]) {
    state.users[uid] = {
      id: Number(from.id),
      username: from.username || "",
      firstName: from.first_name || "",
      lastName: from.last_name || "",
      balanceBdt: 0,
      referralCount: 0,
      referralEarnedBdt: 0,
      referrerId: 0,
      registeredAt: new Date().toISOString()
    };
  } else {
    state.users[uid].username = from.username || state.users[uid].username || "";
    state.users[uid].firstName = from.first_name || state.users[uid].firstName || "";
    state.users[uid].lastName = from.last_name || state.users[uid].lastName || "";
  }
  return state.users[uid];
}

function session(uid) {
  const k = String(uid);
  if (!state.sessions[k]) state.sessions[k] = {};
  return state.sessions[k];
}

function clearSession(uid) {
  state.sessions[String(uid)] = {};
}

function balanceOf(uid) {
  return round2(state.users[String(uid)]?.balanceBdt || 0);
}

function changeBalance(uid, amount, note = "") {
  const u = state.users[String(uid)];
  if (!u) return false;
  const next = round2(Number(u.balanceBdt || 0) + Number(amount || 0));
  if (next < -0.001) return false;
  u.balanceBdt = Math.max(0, next);
  if (!Array.isArray(u.ledger)) u.ledger = [];
  u.ledger.push({
    amount: round2(amount),
    note,
    at: new Date().toISOString()
  });
  if (u.ledger.length > 100) u.ledger = u.ledger.slice(-100);
  return true;
}

function salePriceBdt(product) {
  if (product.source === "local") return Math.round(Number(product.priceBdt || 0));
  return Math.round(
    Number(product.supplierPrice || 0) * Number(state.settings.usdToBdt || DEFAULT_USD_TO_BDT) +
    Number(state.settings.markupBdt || DEFAULT_MARKUP_BDT)
  );
}

function stockText(p) {
  if (p.unlimitedStock) return "∞";
  return String(Math.max(0, Number(p.stock || 0)));
}

function iconFor(title) {
  const n = String(title || "").toLowerCase();
  if (/chatgpt|openai|gpt/.test(n)) return "🤖";
  if (/gemini|google ai/.test(n)) return "✨";
  if (/cursor|github|copilot|code|coding/.test(n)) return "💻";
  if (/notion/.test(n)) return "📝";
  if (/outlook|gmail|email|mail/.test(n)) return "📧";
  if (/netflix|youtube|spotify|video|music/.test(n)) return "🎬";
  if (/canva|figma|design|lovable/.test(n)) return "🎨";
  if (/vpn|proxy/.test(n)) return "🌐";
  if (/account/.test(n)) return "👤";
  return "📦";
}

function short(v, max = 30) {
  const s = String(v || "Product").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

async function tg(method, payload = {}) {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(40000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.description || `${method} failed (${res.status})`);
  }
  return data.result;
}

async function send(chatId, text, replyMarkup, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...extra
  });
}

function mainKeyboard(uid) {
  const rows = [
    [btn("🛍 Products", "primary"), btn("💰 Balance", "success")],
    [btn("➕ Deposit", "success"), btn("🎁 Referral", "primary")],
    [btn("📦 My Orders", "primary"), btn("❓ How to Buy", "primary")],
    [btn("💬 Support", "danger")]
  ];
  if (isOwner(uid)) rows.push([btn("⚙️ Admin Panel", "danger")]);
  return keyboard(rows, "Choose a Sarour Store option");
}

function adminKeyboard() {
  return keyboard([
    [btn("🔄 Sync Products", "success"), btn("💰 Store Wallet", "primary")],
    [btn("➕ Add Product", "success"), btn("🧩 Product Manager", "primary")],
    [btn("🧾 Order Manager", "primary"), btn("💳 Deposit Requests", "primary")],
    [btn("👤 User Balance", "primary"), btn("📊 Sales Report", "primary")],
    [btn("⚙️ Store Settings", "primary"), btn("👑 Owner Access", "danger")],
    [btn("🏠 Home", "danger")]
  ], "Admin control");
}

async function showHome(chatId, from) {
  const u = userRecord(from);
  clearSession(from.id);
  await persist();
  const channel = cleanUsername(CHANNEL_USERNAME);
  const group = cleanUsername(GROUP_USERNAME);
  await send(
    chatId,
    `╭━━━━━━━━━━━━━━━━━━╮
       🛒 <b>${esc(state.settings.storeName)}</b>
╰━━━━━━━━━━━━━━━━━━╯

Hello <b>${esc(from.first_name || "Customer")}</b> 👋

👛 Balance: <b>${moneyBdt(u.balanceBdt)}</b>

✅ Live stock products
⚡ Fast order processing
🔐 Private delivery
🎁 Referral rewards

📢 Channel: <a href="https://t.me/${esc(channel)}">@${esc(channel)}</a>
👥 Group: <a href="https://t.me/${esc(group)}">@${esc(group)}</a>

Choose an option below.`,
    mainKeyboard(from.id)
  );
}

async function supplierFetch(route, options = {}) {
  if (!SUPPLIER_API_KEY) throw new Error("Store API key is not configured.");
  const res = await fetch(`${SUPPLIER_API}${route}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SUPPLIER_API_KEY}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(45000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success !== true) {
    const e = new Error(wl(data?.error?.message || `Store API error (${res.status})`));
    e.code = data?.error?.code || String(res.status);
    throw e;
  }
  return data;
}

async function syncProducts(silent = false, notifyChatId = null) {
  if (!SUPPLIER_API_KEY) {
    if (!silent && notifyChatId) await send(notifyChatId, "❌ Store connection is not configured.", adminKeyboard());
    return 0;
  }

  let page = 1;
  const limit = 100;
  const items = [];

  while (page <= 20) {
    const p = await supplierFetch(`/products?in_stock=true&page=${page}&limit=${limit}`);
    const rows = Array.isArray(p.data) ? p.data : [];
    items.push(...rows);
    const total = Number(p.meta?.total || rows.length);
    if (rows.length < limit || items.length >= total) break;
    page += 1;
  }

  state.products = items
    .filter(x => x && x.id != null && x.name)
    .map(item => ({
      id: `S${item.id}`,
      externalId: Number(item.id),
      title: wl(item.name),
      description: wl(item.description || ""),
      category: wl(item.category?.name || "Digital Products"),
      type: String(item.type || "code"),
      supplierPrice: Number(item.price || 0),
      supplierCurrency: String(item.currency || "USDT"),
      stock: item.unlimited_stock ? 999999 : Math.max(0, Number(item.stock || 0)),
      unlimitedStock: item.unlimited_stock === true,
      deliveryMode: String(item.delivery || "instant"),
      maxQuantity: Math.max(1, Number(item.max_quantity || 1)),
      requires: Array.isArray(item.requires) ? item.requires : [],
      source: "supplier",
      active: item.in_stock !== false
    }));

  state.settings.syncedAt = new Date().toISOString();
  await persist();

  if (!silent && notifyChatId) {
    await send(
      notifyChatId,
      `✅ <b>STOCK UPDATED</b>

📦 Available products: <b>${state.products.length}</b>
💱 USD rate: <b>৳${Number(state.settings.usdToBdt).toFixed(2)}</b>
💹 Profit/product: <b>${moneyBdt(state.settings.markupBdt)}</b>`,
      adminKeyboard()
    );
  }
  return state.products.length;
}

function availableProducts() {
  return [...state.products, ...state.localProducts]
    .filter(p => p.active !== false && (p.unlimitedStock || Number(p.stock || 0) > 0));
}

async function showProducts(chatId, uid, page = 0) {
  const products = availableProducts();
  const perPage = 12;
  const pages = Math.max(1, Math.ceil(products.length / perPage));
  page = Math.max(0, Math.min(Number(page || 0), pages - 1));
  const visible = products.slice(page * perPage, page * perPage + perPage);

  const rows = [];
  const map = {};
  for (const p of visible) {
    let title = short(p.title, 30);
    let label = `${iconFor(p.title)} ${title} | ${moneyBdt(salePriceBdt(p))} | 📦 ${stockText(p)}`;
    while (label.length > 63 && title.length > 12) {
      title = short(title, title.length - 1);
      label = `${iconFor(p.title)} ${title} | ${moneyBdt(salePriceBdt(p))} | 📦 ${stockText(p)}`;
    }
    if (map[label]) label = `${short(label, 58)} ·${String(p.id).slice(-3)}`;
    map[label] = p.id;
    rows.push([btn(label, "success")]);
  }

  const nav = [];
  if (page > 0) nav.push(btn(`⬅️ Products ${page}`, "primary"));
  if (page + 1 < pages) nav.push(btn(`➡️ Products ${page + 2}`, "primary"));
  if (nav.length) rows.push(nav);
  rows.push([btn("🔄 Refresh Products", "success"), btn("🏠 Home", "danger")]);

  const ss = session(uid);
  ss.productMap = map;
  ss.productPage = page;
  await persist();

  await send(
    chatId,
    products.length
      ? `🛍 <b>PRODUCTS</b>

Select a product below.
Page <b>${page + 1}/${pages}</b>`
      : "📭 No product is currently available.",
    keyboard(rows, "Select a product")
  );
}

function findProduct(id) {
  return [...state.products, ...state.localProducts].find(p => String(p.id) === String(id));
}

async function showProduct(chatId, uid, p) {
  const u = state.users[String(uid)];
  const price = salePriceBdt(p);
  session(uid).selectedProductId = p.id;
  await persist();

  const req = p.requires?.length
    ? p.requires.map(x => String(x).replace(/_/g, " ")).join(", ")
    : "Nothing";

  await send(
    chatId,
    `╭━━━━ 🛍 <b>PRODUCT DETAILS</b> ━━━━╮

🏷 <b>${esc(p.title)}</b>
📂 Category: <b>${esc(p.category || "Digital Product")}</b>
💰 Price: <b>${moneyBdt(price)}</b>
👛 Your balance: <b>${moneyBdt(u?.balanceBdt || 0)}</b>
📦 Stock: <b>${esc(stockText(p))}</b>
⚡ Delivery: <b>${esc(p.deliveryMode || "instant")}</b>
🧩 Type: <b>${esc(p.type || "digital")}</b>
🔢 Max/order: <b>${Number(p.maxQuantity || 1)}</b>
📥 Required: <b>${esc(req)}</b>

📝 <b>Description</b>
${esc(p.description || "Digital product with secure delivery.")}

╰━━━━━━━━━━━━━━━━━━╯`,
    keyboard([
      [btn("✅ Buy Now", "success")],
      [btn("➕ Deposit", "success"), btn("⬅️ Back to Products", "primary")],
      [btn("🏠 Home", "danger")]
    ], "Buy or go back")
  );
}

async function showBalance(chatId, uid) {
  const u = state.users[String(uid)];
  const ledger = Array.isArray(u?.ledger) ? u.ledger.slice(-5).reverse() : [];
  let lines = `╭━━━━ 💰 <b>MY BALANCE</b> ━━━━╮

👛 Available: <b>${moneyBdt(u?.balanceBdt || 0)}</b>
🎁 Referral count: <b>${Number(u?.referralCount || 0)}</b>
🎉 Referral earned: <b>${moneyBdt(u?.referralEarnedBdt || 0)}</b>`;

  if (ledger.length) {
    lines += "\n\n<b>Recent activity</b>\n";
    for (const x of ledger) {
      lines += `${Number(x.amount) >= 0 ? "🟢 +" : "🔴 "}${moneyBdt(Math.abs(x.amount))} — ${esc(x.note || "Balance update")}\n`;
    }
  }
  lines += "\n╰━━━━━━━━━━━━━━━━━━╯";

  await send(chatId, lines, keyboard([
    [btn("➕ Deposit", "success"), btn("🎁 Referral", "primary")],
    [btn("🛍 Products", "primary"), btn("🏠 Home", "danger")]
  ], "Wallet options"));
}

async function startDeposit(chatId, uid) {
  if (!state.settings.depositsEnabled) {
    await send(chatId, "⚠️ Deposits are temporarily disabled.", mainKeyboard(uid));
    return;
  }
  if (!state.settings.depositAccount) {
    await send(chatId, "⚠️ Deposit account is not configured yet. Please contact support.", mainKeyboard(uid));
    return;
  }
  const s = session(uid);
  s.mode = "deposit_amount";
  await persist();
  await send(
    chatId,
    `➕ <b>DEPOSIT</b>

Minimum deposit: <b>${moneyBdt(state.settings.minDepositBdt)}</b>

Choose an amount or tap Custom Amount.`,
    keyboard([
      [btn("৳100", "success"), btn("৳200", "success")],
      [btn("৳500", "success"), btn("৳1000", "success")],
      [btn("✍️ Custom Amount", "primary")],
      [btn("❌ Cancel", "danger")]
    ], "Choose deposit amount")
  );
}

async function askDepositReference(chatId, uid, amount) {
  const ss = session(uid);
  ss.mode = "deposit_reference";
  ss.depositAmount = amount;
  await persist();
  await send(
    chatId,
    `💳 <b>PAYMENT DETAILS</b>

Method: <b>${esc(state.settings.depositMethod)}</b>
Account/Address:
<code>${esc(state.settings.depositAccount)}</code>

Amount: <b>${moneyBdt(amount)}</b>

${esc(state.settings.depositInstructions)}

Now send your transaction/reference ID.`,
    keyboard([[btn("❌ Cancel", "danger")]], "Send transaction/reference ID")
  );
}

async function submitDeposit(chatId, from, reference) {
  const ss = session(from.id);
  const amount = Number(ss.depositAmount || 0);
  if (amount < Number(state.settings.minDepositBdt || 1)) {
    clearSession(from.id);
    await persist();
    await send(chatId, "❌ Invalid deposit amount.", mainKeyboard(from.id));
    return;
  }

  if (state.deposits.some(d => String(d.reference).toLowerCase() === String(reference).toLowerCase() && d.status !== "rejected")) {
    await send(chatId, "⚠️ This transaction/reference ID was already submitted.", mainKeyboard(from.id));
    clearSession(from.id);
    await persist();
    return;
  }

  const id = `DP${Date.now().toString(36).toUpperCase()}`;
  state.deposits.push({
    id,
    userId: Number(from.id),
    username: from.username || "",
    fullName: `${from.first_name || ""} ${from.last_name || ""}`.trim(),
    amountBdt: amount,
    reference: String(reference).slice(0, 180),
    method: state.settings.depositMethod,
    status: "pending",
    createdAt: new Date().toISOString()
  });
  clearSession(from.id);
  await persist();

  await send(
    chatId,
    `✅ <b>DEPOSIT REQUEST SUBMITTED</b>

Request: <code>${esc(id)}</code>
Amount: <b>${moneyBdt(amount)}</b>
Status: <b>Pending Review</b>

Your balance updates after admin approval.`,
    mainKeyboard(from.id)
  );

  for (const oid of [OWNER_ID, Number(state.settings.extraOwnerId || 0)].filter(Boolean)) {
    try {
      await send(
        oid,
        `💳 <b>NEW DEPOSIT REQUEST</b>

🆔 <code>${esc(id)}</code>
👤 ${esc(from.first_name || "User")}
🔢 <code>${from.id}</code>
💰 <b>${moneyBdt(amount)}</b>
🧾 <code>${esc(reference)}</code>

Open Admin Panel → Deposit Requests.`,
        adminKeyboard()
      );
    } catch {}
  }
}

async function showReferral(chatId, uid) {
  const u = state.users[String(uid)];
  const username = botUsername || "YOUR_BOT_USERNAME";
  const link = `https://t.me/${username}?start=ref_${uid}`;
  await send(
    chatId,
    `🎁 <b>REFERRAL</b>

Your referrals: <b>${Number(u?.referralCount || 0)}</b>
Earned: <b>${moneyBdt(u?.referralEarnedBdt || 0)}</b>
Reward per new user: <b>${moneyBdt(state.settings.referralRewardBdt)}</b>

Your referral link:
<code>${esc(link)}</code>`,
    keyboard([[btn("🏠 Home", "danger")]], "Referral")
  );
}

async function registerReferral(from, startParam) {
  const u = userRecord(from);
  if (u.referrerId || !startParam) return;
  const m = String(startParam).match(/^ref_(\d+)$/);
  if (!m) return;
  const inviterId = Number(m[1]);
  if (!inviterId || inviterId === Number(from.id) || !state.users[String(inviterId)]) return;

  u.referrerId = inviterId;
  const inviter = state.users[String(inviterId)];
  inviter.referralCount = Number(inviter.referralCount || 0) + 1;

  const reward = Math.max(0, Number(state.settings.referralRewardBdt || 0));
  if (reward > 0) {
    inviter.referralEarnedBdt = round2(Number(inviter.referralEarnedBdt || 0) + reward);
    changeBalance(inviterId, reward, `Referral reward for user ${from.id}`);
  }
  await persist();

  try {
    await send(inviterId, `🎉 New referral joined! Reward: <b>${moneyBdt(reward)}</b>`, mainKeyboard(inviterId));
  } catch {}
}

async function beginPurchase(chatId, from, p) {
  const price = salePriceBdt(p);
  const bal = balanceOf(from.id);
  if (bal < price) {
    await send(
      chatId,
      `❌ <b>INSUFFICIENT BALANCE</b>

Product price: <b>${moneyBdt(price)}</b>
Your balance: <b>${moneyBdt(bal)}</b>
Need: <b>${moneyBdt(price - bal)}</b>`,
      keyboard([
        [btn("➕ Deposit", "success"), btn("💰 Balance", "primary")],
        [btn("⬅️ Back to Products", "primary"), btn("🏠 Home", "danger")]
      ], "Add balance")
    );
    return;
  }

  const requires = Array.isArray(p.requires) ? [...p.requires] : [];
  const payload = {};

  for (const f of [...requires]) {
    if (f === "telegram_user_id" || f === "telegram_id") {
      payload[f] = Number(from.id);
      requires.splice(requires.indexOf(f), 1);
    } else if (f === "telegram_username" && from.username) {
      payload[f] = `@${from.username.replace(/^@/, "")}`;
      requires.splice(requires.indexOf(f), 1);
    }
  }

  if (requires.length) {
    const ss = session(from.id);
    ss.mode = "checkout_fields";
    ss.productId = p.id;
    ss.fields = requires;
    ss.fieldIndex = 0;
    ss.customerPayload = payload;
    await persist();
    await send(
      chatId,
      `📝 Send <b>${esc(requires[0].replace(/_/g, " "))}</b> for this product.`,
      keyboard([[btn("❌ Cancel", "danger")]], "Enter required information")
    );
    return;
  }

  await processPurchase(chatId, from, p, payload);
}

async function processPurchase(chatId, from, p, customerPayload = {}) {
  const price = salePriceBdt(p);
  if (balanceOf(from.id) < price) {
    await showBalance(chatId, from.id);
    return;
  }

  const orderId = `SS${Date.now().toString(36).toUpperCase()}${String(from.id).slice(-3)}`;
  if (!changeBalance(from.id, -price, `Purchase: ${p.title}`)) {
    await showBalance(chatId, from.id);
    return;
  }

  const order = {
    id: orderId,
    userId: Number(from.id),
    productId: p.id,
    productTitle: p.title,
    priceBdt: price,
    source: p.source,
    status: "processing",
    supplierOrderId: "",
    delivery: "",
    createdAt: new Date().toISOString()
  };
  state.orders.push(order);
  await persist();

  try {
    if (p.source === "supplier") {
      if (!state.settings.autoOrderEnabled || !SUPPLIER_API_KEY) throw new Error("Automatic ordering is temporarily unavailable.");

      const result = await supplierFetch("/orders", {
        method: "POST",
        body: JSON.stringify({
          product_id: Number(p.externalId),
          quantity: 1,
          client_order_id: orderId,
          ...(Object.keys(customerPayload).length ? { customer_payload: customerPayload } : {})
        })
      });

      const d = result.data || {};
      order.supplierOrderId = String(d.id || "");
      order.status = d.status === "completed" ? "completed" : (d.status === "pending_manual" ? "pending_manual" : String(d.status || "processing"));
      order.delivery = wl(d.content || (Array.isArray(d.items) ? d.items.join("\n") : ""));

      if (!p.unlimitedStock) p.stock = Math.max(0, Number(p.stock || 0) - 1);
    } else {
      order.status = "pending_manual";
      if (!p.unlimitedStock) p.stock = Math.max(0, Number(p.stock || 0) - 1);
    }

    await persist();

    if (order.status === "completed" && order.delivery) {
      await send(
        chatId,
        `✅ <b>ORDER COMPLETED</b>

🆔 <code>${esc(order.id)}</code>
🛍 ${esc(order.productTitle)}
💰 Paid: <b>${moneyBdt(order.priceBdt)}</b>

🎁 <b>YOUR DELIVERY</b>
<code>${esc(order.delivery)}</code>`,
        mainKeyboard(from.id)
      );
    } else {
      await send(
        chatId,
        `🕓 <b>ORDER ACCEPTED</b>

🆔 <code>${esc(order.id)}</code>
🛍 ${esc(order.productTitle)}
💰 Paid: <b>${moneyBdt(order.priceBdt)}</b>
Status: <b>Pending Delivery</b>

Open My Orders later to refresh.`,
        mainKeyboard(from.id)
      );
    }
  } catch (err) {
    order.status = "failed";
    order.error = wl(err.message);
    changeBalance(from.id, price, `Refund: ${p.title}`);
    await persist();
    await send(
      chatId,
      `❌ <b>ORDER FAILED</b>

${esc(wl(err.message || "Please try again."))}

↩️ The charged amount was returned to your balance.`,
      mainKeyboard(from.id)
    );
  }
}

async function refreshOrder(order) {
  if (order.source !== "supplier" || order.status !== "pending_manual" || !SUPPLIER_API_KEY) return order;
  try {
    const r = await supplierFetch(`/orders/${encodeURIComponent(order.supplierOrderId || order.id)}`);
    const d = r.data || {};
    order.status = d.status === "completed" ? "completed" : String(d.status || order.status);
    const delivery = wl(d.content || (Array.isArray(d.items) ? d.items.join("\n") : ""));
    if (delivery) order.delivery = delivery;
  } catch {}
  return order;
}

async function showOrders(chatId, uid) {
  const mine = state.orders.filter(o => Number(o.userId) === Number(uid)).slice(-10).reverse();
  for (const o of mine.filter(x => x.status === "pending_manual").slice(0, 5)) await refreshOrder(o);
  await persist();

  if (!mine.length) {
    await send(chatId, "📦 You have no orders yet.", mainKeyboard(uid));
    return;
  }

  let text = "📦 <b>MY ORDERS</b>\n\n";
  for (const o of mine) {
    const icon = o.status === "completed" ? "✅" : o.status === "failed" ? "❌" : "🕓";
    text += `${icon} <b>${esc(o.productTitle)}</b>
Order: <code>${esc(o.id)}</code>
Paid: <b>${moneyBdt(o.priceBdt)}</b>
Status: <b>${esc(o.status)}</b>`;
    if (o.status === "completed" && o.delivery) text += `\nDelivery: <code>${esc(o.delivery)}</code>`;
    text += "\n────────────\n";
  }
  await send(chatId, text, mainKeyboard(uid));
}

async function showAdmin(chatId) {
  const open = state.orders.filter(o => !["completed", "failed", "cancelled"].includes(o.status)).length;
  const completed = state.orders.filter(o => o.status === "completed");
  const pendingDeposits = state.deposits.filter(d => d.status === "pending").length;
  const sales = completed.reduce((a, o) => a + Number(o.priceBdt || 0), 0);

  await send(
    chatId,
    `╭━━━━ ⚙️ <b>ADMIN CONTROL</b> ━━━━╮

👥 Users: <b>${Object.keys(state.users).length}</b>
📦 Live products: <b>${state.products.length}</b>
🧩 Manual products: <b>${state.localProducts.length}</b>
🧾 Orders: <b>${state.orders.length}</b>
⏳ Open orders: <b>${open}</b>
💳 Pending deposits: <b>${pendingDeposits}</b>
✅ Completed: <b>${completed.length}</b>
💵 Sales: <b>${moneyBdt(sales)}</b>
💱 USD rate: <b>৳${Number(state.settings.usdToBdt).toFixed(2)}</b>
💹 Markup: <b>${moneyBdt(state.settings.markupBdt)}</b>

Select a button below.
╰━━━━━━━━━━━━━━━━━━╯`,
    adminKeyboard()
  );
}

async function showStoreWallet(chatId) {
  try {
    const r = await supplierFetch("/balance");
    await send(
      chatId,
      `💰 <b>STORE WALLET</b>

Available:
<b>${esc(r.data?.currency || "USDT")} ${Number(r.data?.balance || 0).toFixed(2)}</b>`,
      adminKeyboard()
    );
  } catch (e) {
    await send(chatId, `⚠️ Wallet could not be refreshed.\n\n${esc(wl(e.message))}`, adminKeyboard());
  }
}

async function showPendingDeposits(chatId, uid) {
  const list = state.deposits.filter(d => d.status === "pending").slice(-12).reverse();
  const rows = [];
  const map = {};
  for (const d of list) {
    const label = `💳 ${d.id} | ${moneyBdt(d.amountBdt)} | ${d.userId}`;
    map[label] = d.id;
    rows.push([btn(label, "primary")]);
  }
  rows.push([btn("⚙️ Admin Panel", "danger")]);
  session(uid).depositMap = map;
  await persist();
  await send(
    chatId,
    list.length ? `💳 <b>DEPOSIT REQUESTS</b>\n\nPending: <b>${list.length}</b>\nSelect one below.` : "✅ No pending deposit requests.",
    keyboard(rows, "Select deposit")
  );
}

async function showDepositAdmin(chatId, uid, id) {
  const d = state.deposits.find(x => x.id === id);
  if (!d) return showPendingDeposits(chatId, uid);
  session(uid).selectedDepositId = id;
  await persist();
  await send(
    chatId,
    `💳 <b>DEPOSIT DETAILS</b>

🆔 <code>${esc(d.id)}</code>
👤 ${esc(d.fullName || "User")}
🔢 <code>${d.userId}</code>
💰 <b>${moneyBdt(d.amountBdt)}</b>
💳 ${esc(d.method)}
🧾 <code>${esc(d.reference)}</code>
📌 <b>${esc(d.status)}</b>

Verify payment before approving.`,
    keyboard([
      [btn("✅ Approve Deposit", "success"), btn("❌ Reject Deposit", "danger")],
      [btn("⬅️ Deposit Requests", "primary"), btn("⚙️ Admin Panel", "danger")]
    ], "Deposit action")
  );
}

async function approveDeposit(chatId, uid, approve) {
  const id = session(uid).selectedDepositId;
  const d = state.deposits.find(x => x.id === id);
  if (!d || d.status !== "pending") {
    await showPendingDeposits(chatId, uid);
    return;
  }
  d.status = approve ? "approved" : "rejected";
  d.reviewedAt = new Date().toISOString();
  d.reviewedBy = Number(uid);

  if (approve) {
    if (!state.users[String(d.userId)]) {
      state.users[String(d.userId)] = { id: d.userId, balanceBdt: 0, referralCount: 0, referralEarnedBdt: 0 };
    }
    changeBalance(d.userId, d.amountBdt, `Deposit approved: ${d.id}`);
  }
  await persist();

  try {
    await send(
      d.userId,
      approve
        ? `✅ <b>DEPOSIT APPROVED</b>\n\nAmount: <b>${moneyBdt(d.amountBdt)}</b>\nNew balance: <b>${moneyBdt(balanceOf(d.userId))}</b>`
        : `❌ <b>DEPOSIT REJECTED</b>\n\nRequest: <code>${esc(d.id)}</code>`,
      mainKeyboard(d.userId)
    );
  } catch {}

  await send(chatId, approve ? "✅ Deposit approved and balance added." : "❌ Deposit rejected.", adminKeyboard());
}

async function showSettings(chatId) {
  await send(
    chatId,
    `⚙️ <b>STORE SETTINGS</b>

💱 USD → BDT: <b>৳${Number(state.settings.usdToBdt).toFixed(2)}</b>
💹 Profit markup: <b>${moneyBdt(state.settings.markupBdt)}</b>
🎁 Referral reward: <b>${moneyBdt(state.settings.referralRewardBdt)}</b>
💳 Deposit method: <b>${esc(state.settings.depositMethod)}</b>
📥 Deposit account: <code>${esc(state.settings.depositAccount || "Not set")}</code>
📌 Minimum deposit: <b>${moneyBdt(state.settings.minDepositBdt)}</b>
🟢 Deposits: <b>${state.settings.depositsEnabled ? "ON" : "OFF"}</b>
🤖 Auto order: <b>${state.settings.autoOrderEnabled ? "ON" : "OFF"}</b>`,
    keyboard([
      [btn("💱 Set USD Rate", "primary"), btn("💹 Set Markup", "primary")],
      [btn("🎁 Set Referral Reward", "primary"), btn("📌 Set Minimum Deposit", "primary")],
      [btn("💳 Set Deposit Method", "primary"), btn("📥 Set Deposit Account", "primary")],
      [btn("📝 Set Deposit Instructions", "primary")],
      [btn(state.settings.depositsEnabled ? "🔴 Disable Deposits" : "🟢 Enable Deposits", "danger")],
      [btn(state.settings.autoOrderEnabled ? "🔴 Disable Auto Order" : "🟢 Enable Auto Order", "danger")],
      [btn("⚙️ Admin Panel", "danger")]
    ], "Store settings")
  );
}

async function showOwnerAccess(chatId) {
  await send(
    chatId,
    `👑 <b>OWNER ACCESS</b>

Main owner: <code>${OWNER_ID}</code>
Extra owner: <code>${Number(state.settings.extraOwnerId || 0) || "Not set"}</code>`,
    keyboard([
      [btn("➕ Add Extra Owner", "success"), btn("➖ Remove Extra Owner", "danger")],
      [btn("⚙️ Admin Panel", "danger")]
    ], "Owner access")
  );
}

async function showOrderManager(chatId, uid) {
  const list = state.orders.slice(-12).reverse();
  const rows = [];
  const map = {};
  for (const o of list) {
    const label = `🧾 ${o.id} | ${short(o.productTitle, 20)} | ${o.status}`;
    map[label] = o.id;
    rows.push([btn(label, "primary")]);
  }
  rows.push([btn("⚙️ Admin Panel", "danger")]);
  session(uid).orderMap = map;
  await persist();
  await send(chatId, list.length ? "🧾 <b>ORDER MANAGER</b>\n\nSelect an order." : "No orders yet.", keyboard(rows, "Select order"));
}

async function showAdminOrder(chatId, uid, id) {
  const o = state.orders.find(x => x.id === id);
  if (!o) return showOrderManager(chatId, uid);
  session(uid).selectedOrderId = id;
  await persist();

  const rows = [];
  if (o.status === "pending_manual") {
    if (o.source === "supplier") rows.push([btn("🔄 Check Order", "primary")]);
    rows.push([btn("✅ Deliver Order", "success")]);
  }
  if (!["completed", "failed", "cancelled"].includes(o.status)) rows.push([btn("❌ Cancel Order", "danger")]);
  rows.push([btn("⬅️ Order Manager", "primary"), btn("⚙️ Admin Panel", "danger")]);

  await send(
    chatId,
    `🧾 <b>ORDER DETAILS</b>

Order: <code>${esc(o.id)}</code>
User: <code>${o.userId}</code>
Product: <b>${esc(o.productTitle)}</b>
Paid: <b>${moneyBdt(o.priceBdt)}</b>
Status: <b>${esc(o.status)}</b>
Source: <b>${esc(o.source)}</b>`,
    keyboard(rows, "Order action")
  );
}

async function cancelAdminOrder(chatId, uid) {
  const id = session(uid).selectedOrderId;
  const o = state.orders.find(x => x.id === id);
  if (!o || ["completed", "failed", "cancelled"].includes(o.status)) {
    await showOrderManager(chatId, uid);
    return;
  }
  o.status = "cancelled";
  changeBalance(o.userId, Number(o.priceBdt || 0), `Refund: cancelled ${o.id}`);
  await persist();
  try {
    await send(o.userId, `❌ Order <code>${esc(o.id)}</code> was cancelled.\n↩️ Payment returned to your balance.`, mainKeyboard(o.userId));
  } catch {}
  await send(chatId, "✅ Order cancelled and balance refunded.", adminKeyboard());
}

async function showProductManager(chatId, uid) {
  const list = state.localProducts.slice(-12).reverse();
  const rows = [];
  const map = {};
  for (const p of list) {
    const label = `🧩 ${short(p.title, 28)} | ${moneyBdt(p.priceBdt)} | 📦 ${stockText(p)}`;
    map[label] = p.id;
    rows.push([btn(label, "primary")]);
  }
  rows.push([btn("➕ Add Product", "success")]);
  rows.push([btn("⚙️ Admin Panel", "danger")]);
  session(uid).localProductMap = map;
  await persist();
  await send(chatId, list.length ? "🧩 <b>MANUAL PRODUCTS</b>\n\nSelect a product." : "No manual products yet.", keyboard(rows, "Product manager"));
}

async function showLocalProductAdmin(chatId, uid, id) {
  const p = state.localProducts.find(x => x.id === id);
  if (!p) return showProductManager(chatId, uid);
  session(uid).selectedLocalProductId = id;
  await persist();
  await send(
    chatId,
    `🧩 <b>PRODUCT MANAGER</b>

🏷 ${esc(p.title)}
📂 ${esc(p.category)}
💰 ${moneyBdt(p.priceBdt)}
📦 ${esc(stockText(p))}
⚡ ${esc(p.deliveryMode)}
📝 ${esc(p.description || "")}`,
    keyboard([
      [btn("✏️ Edit Name", "primary"), btn("💵 Edit Price", "primary")],
      [btn("📦 Edit Stock", "primary"), btn("📝 Edit Description", "primary")],
      [btn(p.active ? "🙈 Hide Product" : "👁 Show Product", "danger"), btn("🗑 Delete Product", "danger")],
      [btn("⬅️ Product Manager", "primary"), btn("⚙️ Admin Panel", "danger")]
    ], "Edit product")
  );
}

async function startAddProduct(chatId, uid) {
  session(uid).mode = "add_product";
  session(uid).addStep = "title";
  session(uid).draft = {};
  await persist();
  await send(chatId, "➕ <b>ADD PRODUCT — 1/9</b>\n\nSend product name.", keyboard([[btn("❌ Cancel", "danger")]], "Product name"));
}

async function continueAddProduct(chatId, uid, text) {
  const ss = session(uid);
  const d = ss.draft || {};

  if (ss.addStep === "title") {
    d.title = text.slice(0, 120);
    ss.addStep = "category";
    ss.draft = d;
    await persist();
    return send(chatId, "➕ <b>ADD PRODUCT — 2/9</b>\n\nSend category name.", keyboard([[btn("❌ Cancel", "danger")]], "Category"));
  }
  if (ss.addStep === "category") {
    d.category = text.slice(0, 80);
    ss.addStep = "price";
    await persist();
    return send(chatId, "➕ <b>ADD PRODUCT — 3/9</b>\n\nSend selling price in BDT.\nExample: <code>250</code>", keyboard([[btn("❌ Cancel", "danger")]], "Price BDT"));
  }
  if (ss.addStep === "price") {
    const v = Number(text.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(v) || v < 0) return send(chatId, "⚠️ Send a valid price.", keyboard([[btn("❌ Cancel", "danger")]]));
    d.priceBdt = v;
    ss.addStep = "stock";
    await persist();
    return send(chatId, "➕ <b>ADD PRODUCT — 4/9</b>\n\nSend stock amount or choose Unlimited.", keyboard([[btn("♾ Unlimited Stock", "success")], [btn("❌ Cancel", "danger")]], "Stock"));
  }
  if (ss.addStep === "stock") {
    if (text === "♾ Unlimited Stock") {
      d.unlimitedStock = true;
      d.stock = 999999;
    } else {
      const v = Math.floor(Number(text));
      if (!Number.isFinite(v) || v < 0) return send(chatId, "⚠️ Send valid stock.", keyboard([[btn("♾ Unlimited Stock", "success")], [btn("❌ Cancel", "danger")]]));
      d.unlimitedStock = false;
      d.stock = v;
    }
    ss.addStep = "delivery";
    await persist();
    return send(chatId, "➕ <b>ADD PRODUCT — 5/9</b>\n\nChoose delivery mode.", keyboard([[btn("⚡ Instant", "success"), btn("🕓 Manual", "primary")], [btn("❌ Cancel", "danger")]], "Delivery"));
  }
  if (ss.addStep === "delivery") {
    if (!["⚡ Instant", "🕓 Manual"].includes(text)) return;
    d.deliveryMode = text === "⚡ Instant" ? "instant" : "manual";
    ss.addStep = "type";
    await persist();
    return send(chatId, "➕ <b>ADD PRODUCT — 6/9</b>\n\nChoose product type.", keyboard([[btn("🔑 Code", "primary"), btn("👤 Account", "primary")], [btn("📄 File", "primary"), btn("🛠 Service", "primary")], [btn("❌ Cancel", "danger")]], "Product type"));
  }
  if (ss.addStep === "type") {
    const types = { "🔑 Code": "code", "👤 Account": "account", "📄 File": "file", "🛠 Service": "service" };
    if (!types[text]) return;
    d.type = types[text];
    ss.addStep = "maxQuantity";
    await persist();
    return send(chatId, "➕ <b>ADD PRODUCT — 7/9</b>\n\nSend maximum quantity per order.", keyboard([[btn("❌ Cancel", "danger")]], "Max quantity"));
  }
  if (ss.addStep === "maxQuantity") {
    const v = Math.max(1, Math.floor(Number(text)));
    if (!Number.isFinite(v)) return send(chatId, "⚠️ Send a valid quantity.", keyboard([[btn("❌ Cancel", "danger")]]));
    d.maxQuantity = v;
    ss.addStep = "description";
    await persist();
    return send(chatId, "➕ <b>ADD PRODUCT — 8/9</b>\n\nSend product description.", keyboard([[btn("❌ Cancel", "danger")]], "Description"));
  }
  if (ss.addStep === "description") {
    d.description = text.slice(0, 1500);
    ss.addStep = "confirm";
    await persist();
    return send(
      chatId,
      `➕ <b>ADD PRODUCT — 9/9</b>

🏷 ${esc(d.title)}
📂 ${esc(d.category)}
💰 ${moneyBdt(d.priceBdt)}
📦 ${d.unlimitedStock ? "∞" : d.stock}
⚡ ${esc(d.deliveryMode)}
🧩 ${esc(d.type)}
🔢 Max: ${d.maxQuantity}
📝 ${esc(d.description)}

Save this product?`,
      keyboard([[btn("✅ Save Product", "success"), btn("❌ Cancel", "danger")]], "Confirm")
    );
  }
  if (ss.addStep === "confirm" && text === "✅ Save Product") {
    state.localProducts.push({
      id: `L${Date.now().toString(36).toUpperCase()}`,
      title: d.title,
      category: d.category,
      priceBdt: Number(d.priceBdt),
      stock: Number(d.stock || 0),
      unlimitedStock: !!d.unlimitedStock,
      deliveryMode: d.deliveryMode || "manual",
      type: d.type || "code",
      maxQuantity: Number(d.maxQuantity || 1),
      requires: [],
      description: d.description || "",
      source: "local",
      active: true
    });
    clearSession(uid);
    await persist();
    return send(chatId, "✅ Product added successfully.", adminKeyboard());
  }
}

async function handleAdminState(chatId, from, text) {
  const ss = session(from.id);
  if (!isOwner(from.id) || !ss.mode) return false;

  if (ss.mode === "setting_value") {
    const key = ss.settingKey;
    if (["usdToBdt", "markupBdt", "referralRewardBdt", "minDepositBdt"].includes(key)) {
      const v = Number(text.replace(/[^\d.]/g, ""));
      if (!Number.isFinite(v) || v < 0) {
        await send(chatId, "⚠️ Send a valid number.", keyboard([[btn("❌ Cancel", "danger")]]));
        return true;
      }
      state.settings[key] = v;
    } else if (key === "depositMethod") state.settings.depositMethod = text.slice(0, 100);
    else if (key === "depositAccount") state.settings.depositAccount = text.slice(0, 250);
    else if (key === "depositInstructions") state.settings.depositInstructions = text.slice(0, 1000);
    clearSession(from.id);
    await persist();
    await send(chatId, "✅ Setting updated.", adminKeyboard());
    return true;
  }

  if (ss.mode === "owner_add") {
    const id = Number(text);
    if (!Number.isSafeInteger(id) || id <= 0) {
      await send(chatId, "⚠️ Send a valid Telegram numeric user ID.", keyboard([[btn("❌ Cancel", "danger")]]));
      return true;
    }
    state.settings.extraOwnerId = id;
    clearSession(from.id);
    await persist();
    await send(chatId, "✅ Extra owner added.", adminKeyboard());
    return true;
  }

  if (ss.mode === "wallet_lookup") {
    const id = Number(text);
    if (!Number.isSafeInteger(id) || id <= 0) {
      await send(chatId, "⚠️ Send a valid Telegram numeric user ID.", keyboard([[btn("❌ Cancel", "danger")]]));
      return true;
    }
    ss.mode = "";
    ss.walletUserId = id;
    await persist();
    await send(
      chatId,
      `👤 <b>USER BALANCE</b>

User ID: <code>${id}</code>
Balance: <b>${moneyBdt(balanceOf(id))}</b>`,
      keyboard([
        [btn("➕ Add User Balance", "success"), btn("➖ Remove User Balance", "danger")],
        [btn("🔎 Another User", "primary"), btn("⚙️ Admin Panel", "danger")]
      ], "Manage balance")
    );
    return true;
  }

  if (ss.mode === "wallet_change") {
    const amount = Number(text.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      await send(chatId, "⚠️ Send a valid amount.", keyboard([[btn("❌ Cancel", "danger")]]));
      return true;
    }
    const target = Number(ss.walletUserId);
    if (!state.users[String(target)]) state.users[String(target)] = { id: target, balanceBdt: 0, referralCount: 0, referralEarnedBdt: 0 };
    const signed = ss.walletDirection === "remove" ? -amount : amount;
    if (!changeBalance(target, signed, "Admin balance adjustment")) {
      await send(chatId, "❌ User balance is too low for that removal.", adminKeyboard());
    } else {
      await send(chatId, `✅ Balance updated.\nNew balance: <b>${moneyBdt(balanceOf(target))}</b>`, adminKeyboard());
      try { await send(target, `💰 Your balance was updated by admin.\nNew balance: <b>${moneyBdt(balanceOf(target))}</b>`, mainKeyboard(target)); } catch {}
    }
    clearSession(from.id);
    await persist();
    return true;
  }

  if (ss.mode === "manual_delivery") {
    const o = state.orders.find(x => x.id === ss.selectedOrderId);
    if (!o) {
      clearSession(from.id);
      await persist();
      await showOrderManager(chatId, from.id);
      return true;
    }
    o.status = "completed";
    o.delivery = text.slice(0, 4000);
    clearSession(from.id);
    await persist();
    try {
      await send(o.userId, `✅ <b>ORDER COMPLETED</b>\n\nOrder: <code>${esc(o.id)}</code>\nProduct: ${esc(o.productTitle)}\n\n🎁 <b>YOUR DELIVERY</b>\n<code>${esc(o.delivery)}</code>`, mainKeyboard(o.userId));
    } catch {}
    await send(chatId, "✅ Delivery sent to customer.", adminKeyboard());
    return true;
  }

  if (ss.mode === "edit_local") {
    const p = state.localProducts.find(x => x.id === ss.selectedLocalProductId);
    if (!p) {
      clearSession(from.id);
      await persist();
      return true;
    }
    if (ss.editField === "title") p.title = text.slice(0, 120);
    if (ss.editField === "description") p.description = text.slice(0, 1500);
    if (ss.editField === "priceBdt") {
      const v = Number(text.replace(/[^\d.]/g, ""));
      if (!Number.isFinite(v) || v < 0) return true;
      p.priceBdt = v;
    }
    if (ss.editField === "stock") {
      const v = Math.floor(Number(text));
      if (!Number.isFinite(v) || v < 0) return true;
      p.unlimitedStock = false;
      p.stock = v;
    }
    clearSession(from.id);
    await persist();
    await send(chatId, "✅ Product updated.", adminKeyboard());
    return true;
  }

  if (ss.mode === "add_product") {
    await continueAddProduct(chatId, from.id, text);
    return true;
  }

  return false;
}

async function handleMessage(message) {
  if (!message?.from || message.chat?.type !== "private") return;
  const from = message.from;
  const chatId = message.chat.id;
  const text = String(message.text || "").trim();
  if (!text) return;

  const wasNew = !state.users[String(from.id)];
  userRecord(from);

  if (text.startsWith("/start")) {
    const param = text.split(/\s+/, 2)[1] || "";
    if (wasNew) await registerReferral(from, param);
    await showHome(chatId, from);
    return;
  }

  if (text === "❌ Cancel") {
    clearSession(from.id);
    await persist();
    if (isOwner(from.id)) await showAdmin(chatId);
    else await showHome(chatId, from);
    return;
  }

  if (await handleAdminState(chatId, from, text)) return;

  const ss = session(from.id);

  if (ss.mode === "deposit_amount_custom") {
    const amount = Number(text.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(amount) || amount < Number(state.settings.minDepositBdt || 1)) {
      await send(chatId, `⚠️ Minimum deposit is <b>${moneyBdt(state.settings.minDepositBdt)}</b>.`, keyboard([[btn("❌ Cancel", "danger")]]));
      return;
    }
    await askDepositReference(chatId, from.id, amount);
    return;
  }

  if (ss.mode === "deposit_reference") {
    if (text.length < 3) {
      await send(chatId, "⚠️ Send a valid transaction/reference ID.", keyboard([[btn("❌ Cancel", "danger")]]));
      return;
    }
    await submitDeposit(chatId, from, text);
    return;
  }

  if (ss.mode === "checkout_fields") {
    const field = ss.fields?.[ss.fieldIndex];
    if (!field) {
      clearSession(from.id);
      await persist();
      return;
    }
    if (/email/i.test(field) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      await send(chatId, "⚠️ Send a valid email.", keyboard([[btn("❌ Cancel", "danger")]]));
      return;
    }
    ss.customerPayload = ss.customerPayload || {};
    ss.customerPayload[field] = field === "emails" ? [text] : text;
    ss.fieldIndex += 1;
    if (ss.fieldIndex < ss.fields.length) {
      await persist();
      await send(chatId, `📝 Send <b>${esc(ss.fields[ss.fieldIndex].replace(/_/g, " "))}</b>.`, keyboard([[btn("❌ Cancel", "danger")]]));
      return;
    }
    const p = findProduct(ss.productId);
    const payload = ss.customerPayload;
    clearSession(from.id);
    await persist();
    if (p) await processPurchase(chatId, from, p, payload);
    return;
  }

  if (text === "🏠 Home" || text === "Home") return showHome(chatId, from);
  if (text === "🛍 Products" || text === "🛍 Shop" || text === "🔄 Refresh Products") return showProducts(chatId, from.id, 0);
  if (text === "💰 Balance") return showBalance(chatId, from.id);
  if (text === "➕ Deposit") return startDeposit(chatId, from.id);
  if (text === "🎁 Referral") return showReferral(chatId, from.id);
  if (text === "📦 My Orders") return showOrders(chatId, from.id);

  if (text === "❓ How to Buy") {
    await send(
      chatId,
      `❓ <b>HOW TO BUY</b>

1️⃣ Add balance using Deposit.
2️⃣ Open Products.
3️⃣ Choose a green product button.
4️⃣ Check product details and tap Buy Now.
5️⃣ Instant products are delivered automatically.
6️⃣ Manual products appear in My Orders until delivered.`,
      mainKeyboard(from.id)
    );
    return;
  }

  if (text === "💬 Support") {
    await send(
      chatId,
      `💬 <b>SUPPORT CENTER</b>

Owner: <b>${esc(SUPPORT_USERNAME)}</b>
Channel: <a href="https://t.me/${esc(cleanUsername(CHANNEL_USERNAME))}">${esc(CHANNEL_USERNAME)}</a>
Group: <a href="https://t.me/${esc(cleanUsername(GROUP_USERNAME))}">${esc(GROUP_USERNAME)}</a>

Your Telegram ID:
<code>${from.id}</code>`,
      mainKeyboard(from.id)
    );
    return;
  }

  const pm = text.match(/^[⬅️➡️] Products (\d+)$/);
  if (pm) return showProducts(chatId, from.id, Math.max(0, Number(pm[1]) - 1));
  if (text === "⬅️ Back to Products") return showProducts(chatId, from.id, Number(ss.productPage || 0));

  if (ss.productMap?.[text]) {
    const p = findProduct(ss.productMap[text]);
    if (p) return showProduct(chatId, from.id, p);
  }

  if (text === "✅ Buy Now") {
    const p = findProduct(ss.selectedProductId);
    if (p) return beginPurchase(chatId, from, p);
  }

  if (/^৳\d+/.test(text) && ss.mode === "deposit_amount") {
    const amount = Number(text.replace(/[^\d.]/g, ""));
    if (amount >= Number(state.settings.minDepositBdt || 1)) return askDepositReference(chatId, from.id, amount);
  }
  if (text === "✍️ Custom Amount" && ss.mode === "deposit_amount") {
    ss.mode = "deposit_amount_custom";
    await persist();
    await send(chatId, "✍️ Send deposit amount in BDT.", keyboard([[btn("❌ Cancel", "danger")]], "Deposit amount"));
    return;
  }

  if (!isOwner(from.id)) {
    await send(chatId, "Please choose an option from the keyboard.", mainKeyboard(from.id));
    return;
  }

  if (text === "⚙️ Admin Panel") return showAdmin(chatId);
  if (text === "🔄 Sync Products") {
    try { await syncProducts(false, chatId); } catch (e) { await send(chatId, `⚠️ Sync failed.\n\n${esc(wl(e.message))}`, adminKeyboard()); }
    return;
  }
  if (text === "💰 Store Wallet") return showStoreWallet(chatId);
  if (text === "💳 Deposit Requests" || text === "⬅️ Deposit Requests") return showPendingDeposits(chatId, from.id);
  if (ss.depositMap?.[text]) return showDepositAdmin(chatId, from.id, ss.depositMap[text]);
  if (text === "✅ Approve Deposit") return approveDeposit(chatId, from.id, true);
  if (text === "❌ Reject Deposit") return approveDeposit(chatId, from.id, false);

  if (text === "👤 User Balance" || text === "🔎 Another User") {
    ss.mode = "wallet_lookup";
    await persist();
    await send(chatId, "👤 Send the user's Telegram numeric ID.", keyboard([[btn("❌ Cancel", "danger")]], "User ID"));
    return;
  }
  if (text === "➕ Add User Balance" || text === "➖ Remove User Balance") {
    ss.mode = "wallet_change";
    ss.walletDirection = text.startsWith("➕") ? "add" : "remove";
    await persist();
    await send(chatId, "💰 Send the BDT amount.", keyboard([[btn("❌ Cancel", "danger")]], "Amount"));
    return;
  }

  if (text === "⚙️ Store Settings") return showSettings(chatId);
  const settingButtons = {
    "💱 Set USD Rate": "usdToBdt",
    "💹 Set Markup": "markupBdt",
    "🎁 Set Referral Reward": "referralRewardBdt",
    "📌 Set Minimum Deposit": "minDepositBdt",
    "💳 Set Deposit Method": "depositMethod",
    "📥 Set Deposit Account": "depositAccount",
    "📝 Set Deposit Instructions": "depositInstructions"
  };
  if (settingButtons[text]) {
    ss.mode = "setting_value";
    ss.settingKey = settingButtons[text];
    await persist();
    await send(chatId, "✍️ Send the new value.", keyboard([[btn("❌ Cancel", "danger")]], "New value"));
    return;
  }
  if (text === "🔴 Disable Deposits" || text === "🟢 Enable Deposits") {
    state.settings.depositsEnabled = !state.settings.depositsEnabled;
    await persist();
    return showSettings(chatId);
  }
  if (text === "🔴 Disable Auto Order" || text === "🟢 Enable Auto Order") {
    state.settings.autoOrderEnabled = !state.settings.autoOrderEnabled;
    await persist();
    return showSettings(chatId);
  }

  if (text === "👑 Owner Access") return showOwnerAccess(chatId);
  if (text === "➕ Add Extra Owner") {
    ss.mode = "owner_add";
    await persist();
    await send(chatId, "👑 Send the Telegram numeric user ID for the extra owner.", keyboard([[btn("❌ Cancel", "danger")]], "Owner ID"));
    return;
  }
  if (text === "➖ Remove Extra Owner") {
    state.settings.extraOwnerId = 0;
    await persist();
    await send(chatId, "✅ Extra owner removed.", adminKeyboard());
    return;
  }

  if (text === "🧾 Order Manager" || text === "⬅️ Order Manager") return showOrderManager(chatId, from.id);
  if (ss.orderMap?.[text]) return showAdminOrder(chatId, from.id, ss.orderMap[text]);
  if (text === "🔄 Check Order") {
    const o = state.orders.find(x => x.id === ss.selectedOrderId);
    if (o) await refreshOrder(o);
    await persist();
    return o ? showAdminOrder(chatId, from.id, o.id) : showOrderManager(chatId, from.id);
  }
  if (text === "✅ Deliver Order") {
    ss.mode = "manual_delivery";
    await persist();
    await send(chatId, "📨 Send the product/code/account/details to deliver.", keyboard([[btn("❌ Cancel", "danger")]], "Delivery content"));
    return;
  }
  if (text === "❌ Cancel Order") return cancelAdminOrder(chatId, from.id);

  if (text === "📊 Sales Report") {
    const completed = state.orders.filter(o => o.status === "completed");
    const sales = completed.reduce((a, o) => a + Number(o.priceBdt || 0), 0);
    const deposits = state.deposits.filter(d => d.status === "approved").reduce((a, d) => a + Number(d.amountBdt || 0), 0);
    await send(chatId, `📊 <b>SALES REPORT</b>

🧾 Total orders: <b>${state.orders.length}</b>
✅ Completed: <b>${completed.length}</b>
💵 Sales value: <b>${moneyBdt(sales)}</b>
💳 Approved deposits: <b>${moneyBdt(deposits)}</b>`, adminKeyboard());
    return;
  }

  if (text === "➕ Add Product") return startAddProduct(chatId, from.id);
  if (text === "🧩 Product Manager" || text === "⬅️ Product Manager") return showProductManager(chatId, from.id);
  if (ss.localProductMap?.[text]) return showLocalProductAdmin(chatId, from.id, ss.localProductMap[text]);

  if (["✏️ Edit Name", "💵 Edit Price", "📦 Edit Stock", "📝 Edit Description"].includes(text)) {
    ss.mode = "edit_local";
    ss.editField = {
      "✏️ Edit Name": "title",
      "💵 Edit Price": "priceBdt",
      "📦 Edit Stock": "stock",
      "📝 Edit Description": "description"
    }[text];
    await persist();
    await send(chatId, "✍️ Send the new value.", keyboard([[btn("❌ Cancel", "danger")]], "New value"));
    return;
  }
  if (text === "🙈 Hide Product" || text === "👁 Show Product") {
    const p = state.localProducts.find(x => x.id === ss.selectedLocalProductId);
    if (p) p.active = !p.active;
    await persist();
    return p ? showLocalProductAdmin(chatId, from.id, p.id) : showProductManager(chatId, from.id);
  }
  if (text === "🗑 Delete Product") {
    state.localProducts = state.localProducts.filter(x => x.id !== ss.selectedLocalProductId);
    await persist();
    return showProductManager(chatId, from.id);
  }

  await showAdmin(chatId);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.status(200).send("Sarour Store bot is running."));
app.get("/health", (req, res) => res.status(200).json({ ok: true, bot: botUsername || null }));

app.post(WEBHOOK_PATH, async (req, res) => {
  const headerSecret = req.get("x-telegram-bot-api-secret-token");
  if (headerSecret && headerSecret !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  res.sendStatus(200);
  try {
    if (req.body?.message) await handleMessage(req.body.message);
  } catch (e) {
    console.error("Update error:", e);
  }
});

app.use((req, res) => res.status(404).send("Not found"));

async function bootstrap() {
  await storage.init();

  try {
    const me = await tg("getMe");
    botUsername = me.username || "";
    console.log(`Bot: @${botUsername}`);
  } catch (e) {
    console.error("getMe failed:", e.message);
  }

  if (SUPPLIER_API_KEY) {
    try {
      await syncProducts(true);
      console.log(`Initial stock sync: ${state.products.length} products`);
    } catch (e) {
      console.error("Initial stock sync failed:", e.message);
    }
    setInterval(() => {
      syncProducts(true).catch(e => console.error("Auto sync failed:", e.message));
    }, AUTO_SYNC_MINUTES * 60 * 1000).unref();
  }

  if (PUBLIC_URL) {
    try {
      const webhookUrl = `${PUBLIC_URL}${WEBHOOK_PATH}`;
      await tg("setWebhook", {
        url: webhookUrl,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ["message"],
        drop_pending_updates: false
      });
      console.log(`Webhook set: ${PUBLIC_URL}/telegram/webhook/***`);
    } catch (e) {
      console.error("setWebhook failed:", e.message);
    }
  } else {
    console.warn("PUBLIC_URL/RENDER_EXTERNAL_URL not found. Webhook was not registered.");
  }
}

const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`HTTP server listening on ${PORT}`);
  await bootstrap();
});

process.on("SIGTERM", () => {
  server.close(async () => {
    try { await persist(); } catch {}
    process.exit(0);
  });
});
