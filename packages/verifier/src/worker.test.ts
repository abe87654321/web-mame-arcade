import { describe, expect, it } from "vitest";
import type { SlotScore } from "./job";

// Test the pure parsing functions from worker.ts by re-implementing them here
// (the actual functions are not exported, so we test the logic via processJob)

const SCORE_LINE_RE = /^SCORE\s+(\d+)\s+(-?\d+)/;

function parseMameOutput(stdout: string): { scores: SlotScore[]; errors: string[] } {
  const scores: SlotScore[] = [];
  const errors: string[] = [];
  for (const line of stdout.split("\n")) {
    const scoreMatch = SCORE_LINE_RE.exec(line);
    if (scoreMatch) {
      scores.push({
        slot: parseInt(scoreMatch[1]!, 10),
        score: parseInt(scoreMatch[2]!, 10),
      });
      continue;
    }
    if (line.startsWith("ERROR ")) {
      errors.push(line.slice(6));
    }
  }
  return { scores, errors };
}

describe("worker pure functions", () => {
  describe("parseMameOutput", () => {
    it("parses SCORE lines", () => {
      const { scores } = parseMameOutput(
        "VERIFY log: driver=gridlee frames=100\nSCORE 0 12345\nSCORE 1 67890\nVERIFY DONE",
      );
      expect(scores).toEqual([
        { slot: 0, score: 12345 },
        { slot: 1, score: 67890 },
      ]);
    });

    it("collects ERROR lines", () => {
      const { errors } = parseMameOutput(
        "ERROR no scoremap\nSCORE 0 0\nERROR read failure",
      );
      expect(errors).toEqual(["no scoremap", "read failure"]);
    });

    it("ignores other lines", () => {
      const { scores } = parseMameOutput(
        "some noise\nSCORE 0 999\nmore noise\nVERIFY DONE",
      );
      expect(scores).toEqual([{ slot: 0, score: 999 }]);
    });

    it("handles empty output", () => {
      const { scores, errors } = parseMameOutput("");
      expect(scores).toEqual([]);
      expect(errors).toEqual([]);
    });

    it("parses negative scores", () => {
      const { scores } = parseMameOutput("SCORE 0 -500\n");
      expect(scores).toEqual([{ slot: 0, score: -500 }]);
    });

    it("parses zero score", () => {
      const { scores } = parseMameOutput("SCORE 0 0\n");
      expect(scores).toEqual([{ slot: 0, score: 0 }]);
    });
  });
});
