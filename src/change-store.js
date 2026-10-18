import fs from "node:fs";
import path from "node:path";
import { CleverSQLError, jsonSafe, nowIso } from "./utils.js";

const CHANGE_ID_PATTERN = /^chg_[a-f0-9]{14}$/;

export class ChangeStore {
  constructor(stateDir) {
    this.stateDir = path.resolve(stateDir);
    this.changesDir = path.join(this.stateDir, "changes");
    this.auditPath = path.join(this.stateDir, "audit.jsonl");
    fs.mkdirSync(this.changesDir, { recursive: true });
  }

  assertId(changeId) {
    if (!CHANGE_ID_PATTERN.test(changeId)) {
      throw new CleverSQLError("Invalid change id.", {
        status: 400,
        code: "INVALID_CHANGE_ID",
      });
    }
  }

  pathFor(changeId) {
    this.assertId(changeId);
    return path.join(this.changesDir, `${changeId}.json`);
  }

  save(plan) {
    this.assertId(plan.id);
    const target = this.pathFor(plan.id);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(jsonSafe(plan), null, 2)}\n`, "utf8");
    fs.renameSync(temp, target);
    return plan;
  }

  get(changeId) {
    const target = this.pathFor(changeId);
    if (!fs.existsSync(target)) {
      throw new CleverSQLError("Change not found.", {
        status: 404,
        code: "CHANGE_NOT_FOUND",
      });
    }
    const plan = JSON.parse(fs.readFileSync(target, "utf8"));
    if (plan.status === "preview" && Date.parse(plan.expiresAt) <= Date.now()) {
      plan.status = "expired";
    }
    return plan;
  }

  list({ status, limit = 50 } = {}) {
    const files = fs
      .readdirSync(this.changesDir)
      .filter((file) => file.endsWith(".json"));
    const plans = [];

    for (const file of files) {
      try {
        const plan = JSON.parse(
          fs.readFileSync(path.join(this.changesDir, file), "utf8"),
        );
        if (plan.status === "preview" && Date.parse(plan.expiresAt) <= Date.now()) {
          plan.status = "expired";
        }
        if (!status || status === "all" || plan.status === status) {
          plans.push(plan);
        }
      } catch {
        // A partial or manually edited audit file should not take down the workspace.
      }
    }

    return plans
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  counts() {
    const plans = this.list({ limit: Number.MAX_SAFE_INTEGER });
    return {
      preview: plans.filter((plan) => plan.status === "preview").length,
      applied: plans.filter((plan) => plan.status === "applied").length,
      reverted: plans.filter((plan) => plan.status === "reverted").length,
      expired: plans.filter((plan) => plan.status === "expired").length,
      total: plans.length,
    };
  }

  audit(event) {
    const entry = jsonSafe({
      at: nowIso(),
      ...event,
    });
    fs.appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}
