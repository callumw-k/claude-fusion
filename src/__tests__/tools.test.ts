import { clampMaxToolCalls, isMutatingSelection, selectionLabel, selectionToNames } from "../tools.ts";
import { eq, test } from "./_harness.ts";

test("selectionToNames maps modes to Claude Code tool names", () => {
	eq(selectionToNames(undefined), [], "undefined");
	eq(selectionToNames("none"), [], "none");
	eq(selectionToNames("readonly"), ["Read", "Grep", "Glob"], "readonly");
	eq(selectionToNames("all"), ["Read", "Grep", "Glob", "Bash", "Edit", "Write"], "all");
});

test("selectionToNames accepts pi-fusion aliases, dedupes and drops unknown names", () => {
	eq(selectionToNames(["read", "find", "ls", "GLOB", "bash", "fusion", "Read"]), ["Read", "Glob", "Bash"], "aliases and dedupe");
});

test("isMutatingSelection and selectionLabel", () => {
	eq(isMutatingSelection("readonly"), false, "readonly is not mutating");
	eq(isMutatingSelection(["read", "edit"]), true, "edit is mutating");
	eq(selectionLabel(undefined), "none", "label none");
	eq(selectionLabel("all"), "all", "label all");
	eq(selectionLabel(["find", "read"]), "Glob,Read", "label list");
	eq(selectionLabel(["nope"]), "none", "label empty list");
});

test("clampMaxToolCalls bounds and defaults", () => {
	eq(clampMaxToolCalls(undefined), 16, "default");
	eq(clampMaxToolCalls(0), 1, "min");
	eq(clampMaxToolCalls(500), 100, "max");
	eq(clampMaxToolCalls(7.9), 7, "floor");
	eq(clampMaxToolCalls(Number.NaN), 16, "nan");
});
