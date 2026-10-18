import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PEOPLE = [
  ["Maya Chen", "Northstar Labs", "Singapore"],
  ["Jonas Weber", "Kernwerk", "Germany"],
  ["Amara Okafor", "Fieldnote", "Nigeria"],
  ["Theo Martin", "Coté Studio", "France"],
  ["Lucia Rossi", "Forma", "Italy"],
  ["Noah Williams", "Grain & Grid", "United States"],
  ["Sofia Álvarez", "Lumbre", "Spain"],
  ["Kenji Sato", "Mori Systems", "Japan"],
  ["Priya Nair", "Monsoon Data", "India"],
  ["Elena Petrova", "Sputnik Health", "Bulgaria"],
  ["Samir Haddad", "Cedar Cloud", "United Arab Emirates"],
  ["Freya Larsen", "Nordlys", "Norway"],
  ["Ethan Clarke", "Relay Works", "Australia"],
  ["Ines Santos", "Vela", "Brazil"],
  ["Mateo Silva", "Trama", "Mexico"],
  ["Ava Thompson", "Juniper AI", "Canada"],
  ["Omar El-Sayed", "Nile Robotics", "Egypt"],
  ["Nora Kim", "Han River Co.", "South Korea"],
  ["Liam O'Connor", "Tandem", "Ireland"],
  ["Zara Khan", "Mosaic Finance", "Pakistan"],
  ["Ben Carter", "Harbor", "United Kingdom"],
  ["Ana Costa", "Fio", "Portugal"],
  ["Elias Novak", "Kite", "Czechia"],
  ["Isla Morgan", "Signal Foundry", "New Zealand"],
  ["Ravi Patel", "Banyan", "India"],
  ["Mei Lin", "Quiet Current", "Taiwan"],
  ["Tomasz Kowalski", "Formline", "Poland"],
  ["Alina Popescu", "Vector House", "Romania"],
  ["Daniel Reyes", "Brisa", "Chile"],
  ["Hana Suzuki", "Kumo", "Japan"],
  ["Sara Ibrahim", "Atlas Studio", "Jordan"],
  ["Oliver Brown", "Low Tide", "United States"],
  ["Camila Torres", "Semilla", "Colombia"],
  ["Felix Bauer", "Kante", "Austria"],
  ["Aisha Bello", "Tempo", "Ghana"],
  ["Leo Dubois", "Miroir", "France"],
  ["Grace Lee", "Orbit Nine", "South Korea"],
  ["Ahmed Farah", "Dune", "Kenya"],
  ["Julia Novak", "Krok", "Slovenia"],
  ["Ruben de Vries", "Delta Layer", "Netherlands"],
  ["Sienna Park", "Maple Loop", "Canada"],
  ["Viktor Petrov", "Linea", "Serbia"],
  ["Layla Hassan", "Mint Route", "Egypt"],
  ["Mason Reed", "Backyard", "United States"],
  ["Chiara Bianchi", "Tela", "Italy"],
  ["Hugo Laurent", "Parallax", "Belgium"],
  ["Aya Nakamura", "Sora", "Japan"],
  ["Arjun Mehta", "Cloudstep", "India"],
];

const PLANS = [
  ["orbit", "Orbit", 2900, 700, "For small teams shipping their first data product."],
  ["pulse", "Pulse", 9900, 900, "For product teams operating live customer data."],
  ["atlas", "Atlas", 29900, 1200, "For scaled teams with governance requirements."],
  ["frontier", "Frontier", 79900, 1500, "For platform teams with custom controls."],
];

const OWNERS = ["maya", "jonas", "amara", "theo", "lena", "sam"];
const COUNTRIES = ["United States", "Germany", "Singapore", "Japan", "United Kingdom", "Canada"];

function makeRandom(seed = 0xc1e4e5) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function pick(random, items) {
  return items[Math.floor(random() * items.length)];
}

function isoDaysAgo(days, hour = 9) {
  const date = new Date(Date.UTC(2026, 9, 17, hour, 0, 0));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE plans (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      monthly_price INTEGER NOT NULL CHECK (monthly_price >= 0),
      seat_price INTEGER NOT NULL CHECK (seat_price >= 0),
      description TEXT NOT NULL
    );

    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      company TEXT NOT NULL,
      country TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('trial', 'active', 'paused', 'churned')),
      owner TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      plan_code TEXT NOT NULL REFERENCES plans(code) ON UPDATE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
      seats INTEGER NOT NULL CHECK (seats > 0),
      mrr INTEGER NOT NULL CHECK (mrr >= 0),
      started_at TEXT NOT NULL,
      renews_at TEXT
    );

    CREATE TABLE invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      number TEXT NOT NULL UNIQUE,
      amount INTEGER NOT NULL CHECK (amount >= 0),
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL CHECK (status IN ('paid', 'open', 'past_due', 'void')),
      issued_at TEXT NOT NULL,
      paid_at TEXT
    );

    CREATE TABLE activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX customers_status_idx ON customers(status);
    CREATE INDEX subscriptions_customer_idx ON subscriptions(customer_id);
    CREATE INDEX subscriptions_status_idx ON subscriptions(status);
    CREATE INDEX invoices_customer_idx ON invoices(customer_id);
    CREATE INDEX invoices_status_idx ON invoices(status);
    CREATE INDEX activity_customer_idx ON activity_events(customer_id);
  `);
}

function seedRows(db) {
  const random = makeRandom();
  const insertPlan = db.prepare(
    "INSERT INTO plans (code, name, monthly_price, seat_price, description) VALUES (?, ?, ?, ?, ?)",
  );
  for (const plan of PLANS) insertPlan.run(...plan);

  const insertCustomer = db.prepare(
    `INSERT INTO customers (name, email, company, country, status, owner, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSubscription = db.prepare(
    `INSERT INTO subscriptions (customer_id, plan_code, status, seats, mrr, started_at, renews_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertInvoice = db.prepare(
    `INSERT INTO invoices (customer_id, number, amount, currency, status, issued_at, paid_at)
     VALUES (?, ?, ?, 'USD', ?, ?, ?)`,
  );
  const insertEvent = db.prepare(
    "INSERT INTO activity_events (customer_id, kind, detail, created_at) VALUES (?, ?, ?, ?)",
  );

  const eventKinds = ["query", "change_preview", "change_applied", "schema_inspected", "mcp_connected"];
  const eventDetails = [
    "Explored the active subscription cohort",
    "Previewed a plan upgrade for review",
    "Updated a customer lifecycle status",
    "Inspected foreign keys before a migration",
    "Connected a local agent over MCP",
  ];

  for (let index = 0; index < PEOPLE.length; index += 1) {
    const [name, company, homeCountry] = PEOPLE[index];
    const firstName = name.split(" ")[0].toLowerCase().replaceAll("'", "");
    const email = `${firstName}.${index + 1}@example.dev`;
    const roll = random();
    const customerStatus =
      roll < 0.12 ? "trial" : roll < 0.7 ? "active" : roll < 0.82 ? "paused" : "churned";
    const country = random() < 0.7 ? homeCountry : pick(random, COUNTRIES);
    const customerId = Number(
      insertCustomer.run(
        name,
        email,
        company,
        country,
        customerStatus,
        pick(random, OWNERS),
        isoDaysAgo(80 + index * 7, 8 + (index % 7)),
      ).lastInsertRowid,
    );

    if (index < 42) {
      const plan = index % 11 === 0 ? PLANS[3] : index % 4 === 0 ? PLANS[2] : index % 2 === 0 ? PLANS[1] : PLANS[0];
      const seats = plan[0] === "orbit" ? 2 + Math.floor(random() * 6) : plan[0] === "pulse" ? 4 + Math.floor(random() * 12) : 8 + Math.floor(random() * 20);
      const mrr = plan[2] + seats * plan[3];
      const subStatus =
        customerStatus === "trial"
          ? "trialing"
          : customerStatus === "churned"
            ? "canceled"
            : customerStatus === "paused"
              ? "past_due"
              : "active";
      insertSubscription.run(
        customerId,
        plan[0],
        subStatus,
        seats,
        subStatus === "canceled" ? 0 : mrr,
        isoDaysAgo(65 + index, 10),
        subStatus === "canceled" ? null : isoDaysAgo(-(5 + (index % 25)), 10),
      );
    }

    for (let invoiceIndex = 0; invoiceIndex < 2; invoiceIndex += 1) {
      const issuedDaysAgo = 8 + index * 2 + invoiceIndex * 30;
      const invoiceRoll = random();
      const invoiceStatus =
        invoiceRoll < 0.76 ? "paid" : invoiceRoll < 0.9 ? "open" : invoiceRoll < 0.97 ? "past_due" : "void";
      const amount = 2900 + Math.floor(random() * 65000);
      insertInvoice.run(
        customerId,
        `INV-2026-${String(index * 2 + invoiceIndex + 1).padStart(4, "0")}`,
        amount,
        invoiceStatus,
        isoDaysAgo(issuedDaysAgo, 12),
        invoiceStatus === "paid" ? isoDaysAgo(issuedDaysAgo - 1, 14) : null,
      );
    }

    const eventCount = 2 + Math.floor(random() * 3);
    for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
      const eventTypeIndex = Math.floor(random() * eventKinds.length);
      insertEvent.run(
        customerId,
        eventKinds[eventTypeIndex],
        eventDetails[eventTypeIndex],
        isoDaysAgo(Math.floor(random() * 45), 8 + eventIndex * 3),
      );
    }
  }
}

export function seedDemoDatabase(databasePath, { reset = false } = {}) {
  const absolute = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });

  if (reset) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${absolute}${suffix}`;
      if (fs.existsSync(target)) fs.rmSync(target);
    }
  }

  if (fs.existsSync(absolute)) {
    return { path: absolute, created: false };
  }

  const db = new DatabaseSync(absolute);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    db.exec("BEGIN");
    createSchema(db);
    seedRows(db);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original seed error.
    }
    throw error;
  } finally {
    db.close();
  }

  return { path: absolute, created: true };
}
