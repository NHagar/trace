import type { Diagnostic } from "./types.js";

export class DiagnosticError extends Error {
  constructor(
    message: string,
    readonly diagnostics: Diagnostic[],
  ) {
    super(message);
    this.name = "DiagnosticError";
  }
}

export class LimitReachedError extends Error {
  constructor(readonly limit: "wall_clock" | "model_calls", message: string) {
    super(message);
    this.name = "LimitReachedError";
  }
}

export class InterruptedError extends Error {
  constructor(message = "Run interrupted") {
    super(message);
    this.name = "InterruptedError";
  }
}
