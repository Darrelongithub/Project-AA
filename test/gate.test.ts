import { describe, expect, it } from "vitest";
import { gate } from "../src/gate";

describe("gate: auto-send vs human queue — no exceptions", () => {
  it("Green + watcher ran + clean → auto_send (the ONLY auto-send case)", () => {
    const g = gate("Green", { ran: true, flagged: false });
    expect(g.action).toBe("auto_send");
  });

  it("Green but watcher flagged → human_queue", () => {
    expect(gate("Green", { ran: true, flagged: true }).action).toBe("human_queue");
  });

  it("Green but watcher somehow did not run → human_queue (refuse to auto-send)", () => {
    expect(gate("Green", { ran: false, flagged: false }).action).toBe("human_queue");
  });

  it("Orange always → human_queue", () => {
    expect(gate("Orange", { ran: false, flagged: false }).action).toBe("human_queue");
    expect(gate("Orange", { ran: true, flagged: false }).action).toBe("human_queue");
  });

  it("Red always → human_queue", () => {
    expect(gate("Red", { ran: false, flagged: false }).action).toBe("human_queue");
    expect(gate("Red", { ran: true, flagged: true }).action).toBe("human_queue");
  });
});
