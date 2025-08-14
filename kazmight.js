import fs from "fs";
import path from "path";
import axios from "axios";
import blessed from "blessed";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createRequire } from "module";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const require = createRequire(import.meta.url);
const { CryptoBotUI } = require("./crypto-bot-ui.js");


const API_BASE = "https://wallet.fastset.xyz/api/";
let SENDS_PER_ACCOUNT = parseInt(process.env.SENDS_PER_ACCOUNT || "1", 10);
let DELAY_SECONDS = parseInt(process.env.DELAY_SECONDS || "5", 10);

const tokens = [
  { name: "SET", tokenId: "Internal-FastSet", decimals: 0, faucetAmount: "98686" },
  { name: "USDC", tokenId: "ReFosxqpCeJTBuJXJOSoAFE8F4+fXpftTJBYs8qAaeI=", decimals: 6, faucetAmount: "1000000000" },
  { name: "ETH", tokenId: "webWlA8UWwxnPc+awV0isStdDwYyynDf+eoh3ezEzWc=", decimals: 18, faucetAmount: "3140000000000000000" },
  { name: "SOL", tokenId: "2EJhDfYD4V39bKTVgJUhEd0LAs3VUAfEiGRucXc9eHU=", decimals: 9, faucetAmount: "100000000000" },
  { name: "BTC", tokenId: "/NHeobovw7GeS14wseW3RmvFRQIojkfWEGG+0HaIPtE=", decimals: 8, faucetAmount: "100000000" }
];

const sendRanges = {
  SET: { min: 1, max: 10 },
  USDC: { min: 0.02, max: 0.045 },
  ETH: { min: 0.0003, max: 0.00075 },
  SOL: { min: 0.0003, max: 0.00075 },
  BTC: { min: 0.000003, max: 0.0000075 }
};


const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function from5to8(data) {
  let acc = 0n, bits = 0; const out = []; const maxv = (1 << 8) - 1;
  for (const v of data) { acc = (acc << 5n) | BigInt(v); bits += 5;
    while (bits >= 8) { bits -= 8; out.push(Number((acc >> BigInt(bits)) & BigInt(maxv))); } }
  if (bits >= 5 || Number(acc & ((1n << BigInt(bits)) - 1n)) !== 0) throw new Error("Padding error");
  return Buffer.from(out);
}
function decodeBech32WithoutVerify(address) {
  const lower = address.toLowerCase();
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) throw new Error("Invalid bech32");
  const dataStr = lower.slice(pos + 1);
  const data = [];
  for (const c of dataStr) {
    const idx = CHARSET.indexOf(c);
    if (idx === -1) throw new Error("Invalid char");
    data.push(idx);
  }
  const publicBytes = from5to8(data.slice(0, -6));
  return { publicBytes };
}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randFloat = (min, max) => Math.random() * (max - min) + min;
const short = (s) => (s ? s.slice(0, 6) + "..." + s.slice(-4) : "N/A");

async function createAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    if (proxyUrl.startsWith("socks")) {
      const { SocksProxyAgent } = await import("socks-proxy-agent");
      return new SocksProxyAgent(proxyUrl);
    } else {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      return new HttpsProxyAgent(proxyUrl);
    }
  } catch {
    ui?.log?.("info", `Proxy module not available. Continue without proxy.`);
    return undefined;
  }
}

async function makeApiCall(method, payload, { proxyUrl } = {}) {
  const id = uuidv4();
  const agent = await createAgent(proxyUrl || null);
  const res = await axios.post(API_BASE + method, payload, {
    headers: { "Content-Type": "application/json", "X-Req-Id": id },
    httpsAgent: agent
  });
  if (res.status !== 200) {
    const msg = typeof res.data === "object" ? JSON.stringify(res.data) : String(res.data);
    throw new Error(`API ${method} -> ${res.status}: ${msg}`);
  }
  return res.data;
}


function buildAccount(privateKeyHex, bech32Address) {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) throw new Error("PRIVATE_KEYS must be 64-hex per key (32 bytes)");
  const privateBytes = Buffer.from(privateKeyHex, "hex");
  const { publicBytes } = decodeBech32WithoutVerify(bech32Address);
  const sender = publicBytes.toString("base64");
  const key = Buffer.concat([privateBytes, publicBytes]).toString("base64"); 
  return { privateKeyHex, address: bech32Address, sender, key };
}
function loadAccountsFromEnv() {
  const keys = (process.env.PRIVATE_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
  const addrs = (process.env.ADDRESSES || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!keys.length || !addrs.length) throw new Error("Set PRIVATE_KEYS dan ADDRESSES di .env (comma-separated).");
  if (keys.length !== addrs.length) throw new Error(`PRIVATE_KEYS (${keys.length}) != ADDRESSES (${addrs.length}).`);
  return keys.map((k, i) => buildAccount(k, addrs[i]));
}
function loadRecipients(file = "wallet.txt") {
  const p = path.resolve(__dirname, file);
  if (!fs.existsSync(p)) throw new Error(`wallet.txt not found at ${p}`);
  return fs.readFileSync(p, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function loadProxies() {
  if (process.env.PROXIES) return process.env.PROXIES.split(",").map(s => s.trim()).filter(Boolean);
  const p = path.resolve(__dirname, "proxy.txt");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}


async function dripFaucet(account, token, opts = {}) {
  const sender = account.sender;
  const payload = {
    sender,
    info: {
      recipient: sender,
      amount: token.faucetAmount,
      tokenId: token.tokenId !== "Internal-FastSet" ? token.tokenId : undefined
    }
  };
  if (token.tokenId === "Internal-FastSet") delete payload.info.tokenId;
  await makeApiCall(token.tokenId === "Internal-FastSet" ? "dripBalance" : "dripToken", payload, opts);
  ui.log("success", `Faucet ${token.name} claimed: ${token.faucetAmount}`);
}

async function performSend(account, token, amountHuman, { recipients, ownAddresses = [], proxyUrl } = {}) {
  if (!recipients?.length) throw new Error("No recipients loaded");


  let to;
  for (let guard = 0; guard < 1000; guard++) {
    const cand = recipients[Math.floor(Math.random() * recipients.length)];
    if (!ownAddresses.includes(cand)) { to = cand; break; }
  }
  if (!to) throw new Error("Unable to pick recipient different from own addresses");

  const { publicBytes } = decodeBech32WithoutVerify(to);
  const recipient = publicBytes.toString("base64");
  const sender = account.sender;
  const key = account.key;
  const amount = (BigInt(Math.floor(parseFloat(amountHuman) * 10 ** token.decimals))).toString();

  ui.log("pending", `Preparing ${amountHuman} ${token.name} -> ${short(to)}`);


  const info = await makeApiCall("getAccountInfo", { sender }, { proxyUrl });
  const nextNonce = info.nextNonce;
  let bal = token.tokenId === "Internal-FastSet"
    ? BigInt(info.balance)
    : BigInt(info.tokenBalances?.[token.tokenId] || 0);

  if (bal < BigInt(amount)) {
    ui.log("warning", `Saldo ${token.name} kurang. Claim faucet...`);
    await dripFaucet(account, token, { proxyUrl });
    await sleep(5000);
    const upd = await makeApiCall("getAccountInfo", { sender }, { proxyUrl });
    bal = token.tokenId === "Internal-FastSet"
      ? BigInt(upd.balance)
      : BigInt(upd.tokenBalances?.[token.tokenId] || 0);
    if (bal < BigInt(amount)) throw new Error("Faucet claim failed or insufficient.");
  }

  const payload = {
    sender, key, nextNonce,
    transferInfo: {
      recipient, amount,
      tokenId: token.tokenId !== "Internal-FastSet" ? token.tokenId : undefined
    }
  };
  const method = token.tokenId === "Internal-FastSet" ? "transferBalance" : "transferToken";
  if (method === "transferBalance") delete payload.transferInfo.tokenId;

  await makeApiCall(method, payload, { proxyUrl });
  ui.log("success", `Sent ${amountHuman} ${token.name} -> ${short(to)}`);
  return to;
}


const ui = new CryptoBotUI({
  title: "FASTSET WALLET",
  menuItems: [
    "1. Running Transaction",
    "2. Change Params (Amount TX & Delay)",
    "3. Reload wallet.txt",
    "4. Show Amount",
    "5. Clear Logs",
    "6. Exit"
  ],
  tickerText1: "FASTSET WALLET - ",
  tickerText2: "Join Telegram Channel : Invictuslabs - Airdrops - ",
  nativeSymbol: "SET",
  logFile: process.env.LOG_FILE || "transactions.log",
  mirrorConsole: false
});


async function promptParamsInUI() {
  const C = ui.opts.colors;
  const screen = ui.screen;


  const overlay = blessed.box({
    parent: screen,
    top: 0, left: 0, width: "100%", height: "100%",
    style: { bg: ui.opts.colors.background },
    transparent: false
  });

  const modal = blessed.box({
    parent: overlay,
    label: " Set Parameters ",
    width: "60%", height: 13,
    top: "center", left: "center",
    border: { type: "line" },
    style: { fg: C.text, bg: C.background, border: { fg: C.cyan }, label: { fg: C.cyan, bold: true } },
    tags: true
  });

  const form = blessed.form({
    parent: modal, keys: true, mouse: true, vi: true,
    width: "100%-2", height: "100%-2",
    left: 1, top: 1
  });

  blessed.text({
    parent: form, left: 0, top: 0, tags: true,
    content: `{${C.info}-fg}Masukkan jumlah tx/akun & delay (detik). Tab untuk pindah field, Enter di tombol OK.{/${C.info}-fg}`
  });

  blessed.text({ parent: form, left: 0, top: 2, content: "Jumlah transaksi per akun:" });
  const tbCount = blessed.textbox({
    parent: form, name: "count", inputOnFocus: true,
    left: 0, top: 3, height: 3, width: "50%",
    border: { type: "line" },
    style: { fg: C.text, bg: C.background, border: { fg: "white" }, focus: { border: { fg: C.success } } }
  });
  tbCount.setValue(String(SENDS_PER_ACCOUNT));

  blessed.text({ parent: form, left: 0, top: 6, content: "Delay per transaksi (detik):" });
  const tbDelay = blessed.textbox({
    parent: form, name: "delay", inputOnFocus: true,
    left: 0, top: 7, height: 3, width: "50%",
    border: { type: "line" },
    style: { fg: C.text, bg: C.background, border: { fg: "white" }, focus: { border: { fg: C.success } } }
  });
  tbDelay.setValue(String(DELAY_SECONDS));

  const btnOk = blessed.button({
    parent: form, mouse: true, keys: true,
    shrink: true, padding: { left: 2, right: 2 },
    left: 0, top: 10, content: " OK ",
    style: { fg: "black", bg: C.success, hover: { bg: "green" }, focus: { bg: "green" } }
  });
  const btnCancel = blessed.button({
    parent: form, mouse: true, keys: true,
    shrink: true, padding: { left: 2, right: 2 },
    left: 8, top: 10, content: " Cancel ",
    style: { fg: "black", bg: C.warning, hover: { bg: "yellow" }, focus: { bg: "yellow" } }
  });

  return new Promise((resolve) => {
    const cleanup = () => { try { overlay.detach(); ui.transactionList?.focus(); ui.render(); } catch(_){} };

    btnOk.on("press", () => form.submit());
    btnCancel.on("press", () => { ui.log("info", "Batal ubah parameter"); cleanup(); resolve(false); });

    form.on("submit", (data) => {
      const count = data.count?.trim() ? parseInt(data.count.trim(), 10) : SENDS_PER_ACCOUNT;
      const delay = data.delay?.trim() ? parseInt(data.delay.trim(), 10) : DELAY_SECONDS;
      let changed = false;

      if (Number.isInteger(count) && count > 0) {
        SENDS_PER_ACCOUNT = count; changed = true;
      } else {
        ui.log("warning", "Jumlah tidak valid. Tetap.");
      }
      if (Number.isInteger(delay) && delay >= 0) {
        DELAY_SECONDS = delay; changed = true;
      } else {
        ui.log("warning", "Delay tidak valid. Tetap.");
      }

      if (changed) ui.log("success", `Param di-set: ${SENDS_PER_ACCOUNT} tx/akun, delay ${DELAY_SECONDS}s`);
      cleanup();
      resolve(changed);
    });

    
    tbCount.focus();
    ui.render();
  });
}


async function refreshBalancesFor(account, { proxyUrl } = {}) {
  try {
    const info = await makeApiCall("getAccountInfo", { sender: account.sender }, { proxyUrl });
    const setBal = BigInt(info.balance).toString();
    const tbal = (tid, dec) => {
      const raw = BigInt(info.tokenBalances?.[tid] || 0);
      if (dec === 0) return raw.toString();
      const n = Number(raw) / (10 ** dec);
      return n.toFixed(Math.min(6, dec));
    };

    ui.updateWallet({
      address: account.address,
      nativeBalance: setBal,
      network: "FastSet Testnet",
      gasPrice: "-",
      nonce: String(info.nextNonce ?? "-")
    });
    ui.setTokens([
      { enabled: true, name: "SET", symbol: "SET", balance: setBal },
      { enabled: true, name: "USDC", symbol: "USDC", balance: tbal(tokens[1].tokenId, tokens[1].decimals) },
      { enabled: true, name: "ETH",  symbol: "ETH",  balance: tbal(tokens[2].tokenId, tokens[2].decimals) },
      { enabled: true, name: "SOL",  symbol: "SOL",  balance: tbal(tokens[3].tokenId, tokens[3].decimals) },
      { enabled: true, name: "BTC",  symbol: "BTC",  balance: tbal(tokens[4].tokenId, tokens[4].decimals) }
    ]);
  } catch (e) {
    ui.log("error", `Gagal ambil saldo: ${e.message}`);
  }
}

async function runBatch({ accounts, recipients, proxies, ownAddresses }) {
  ui.setActive(true);
  ui.updateStats({ pendingTx: 0 });
  let ok = 0, fail = 0, total = 0;

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const proxyUrl = proxies.length ? proxies[i % proxies.length] : undefined;

    ui.log("info", `== Account #${i + 1}: ${short(acc.address)} ${proxyUrl ? `(proxy)` : ""} ==`);
    await refreshBalancesFor(acc, { proxyUrl });

    for (let s = 0; s < SENDS_PER_ACCOUNT; s++) {
      total++;
      const token = tokens[Math.floor(Math.random() * tokens.length)];
      const r = sendRanges[token.name];
      const maxDecimals = Math.min(6, token.decimals);
      const amountHuman = randFloat(r.min, r.max).toFixed(maxDecimals);

      try {
        ui.updateStats({ pendingTx: (ui.pendingTx || 0) + 1 });
        await performSend(acc, token, amountHuman, { recipients, ownAddresses, proxyUrl });
        ok++;
      } catch (err) {
        ui.log("error", `Tx gagal: ${err.message}`);
        fail++;
      } finally {
        ui.updateStats({ pendingTx: Math.max(0, (ui.pendingTx || 1) - 1) });
      }

      ui.updateStats({
        transactionCount: (ui.transactionCount || 0) + 1,
        failedTx: fail,
        successRate: total ? (100 * (ok / total)) : 100
      });
      await refreshBalancesFor(acc, { proxyUrl });

      if (s < SENDS_PER_ACCOUNT - 1 && DELAY_SECONDS > 0) {
        ui.log("pending", `Delay ${DELAY_SECONDS}s before next send...`);
        await sleep(DELAY_SECONDS * 1000);
      }
    }

    if (i < accounts.length - 1) {
      ui.log("pending", `Next account in 10s...`);
      await sleep(10_000);
    }
  }

  ui.log("completed", `Selesai batch. OK=${ok}, FAIL=${fail}, TOTAL=${total}`);
  ui.setActive(false);
}


let accounts = [];
let recipients = [];
let proxies = [];
let ownAddresses = [];

async function init() {
  try {
    accounts = loadAccountsFromEnv();
    recipients = loadRecipients("wallet.txt");
    proxies = loadProxies();
    ownAddresses = (process.env.ADDRESSES || "").split(",").map(s => s.trim()).filter(Boolean);

    ui.log("success", `Loaded ${accounts.length} account(s) from .env`);
    ui.log("success", `Loaded ${recipients.length} recipient(s) from wallet.txt`);
    if (proxies.length) ui.log("info", `Loaded ${proxies.length} proxy(ies)`);

    await refreshBalancesFor(accounts[0], { proxyUrl: proxies[0] });
  } catch (e) {
    ui.log("error", e.message);
  }
}

ui.on("menu:select", async (label) => {
  const plain = label.toLowerCase();
  try {
    if (plain.startsWith("1.")) {
      await runBatch({ accounts, recipients, proxies, ownAddresses });
    } else if (plain.startsWith("2.")) {
      await promptParamsInUI(); 
    } else if (plain.startsWith("3.")) {
      try {
        recipients = loadRecipients("wallet.txt");
        ui.log("success", `wallet.txt reloaded. ${recipients.length} recipient(s).`);
      } catch (e) { ui.log("error", e.message); }
    } else if (plain.startsWith("4.")) {
      await refreshBalancesFor(accounts[0], { proxyUrl: proxies[0] });
    } else if (plain.startsWith("5.")) {
      ui.clearLogs();
      ui.log("info", "Logs cleared.");
    } else if (plain.startsWith("6.") || plain.includes("exit")) {
      ui.destroy(0);
    } else {
      ui.log("warning", "Menu tidak dikenal.");
    }
  } catch (e) {
    ui.log("error", e.message);
  }
});


await init();
