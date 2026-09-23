export class PilotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PilotError";
  }
}

export class StalePage extends PilotError {
  constructor(message: string) {
    super(message);
    this.name = "StalePage";
  }
}

export class LocatorMiss extends PilotError {
  candidates: Record<string, unknown>[];
  constructor(message: string, candidates: Record<string, unknown>[] = []) {
    super(message);
    this.name = "LocatorMiss";
    this.candidates = candidates;
  }
}

export class DecisionError extends PilotError {
  constructor(message: string) {
    super(message);
    this.name = "DecisionError";
  }
}

export class EmptyField extends PilotError {
  constructor() {
    super("Text model returned no field value; nothing typed");
    this.name = "EmptyField";
  }
}

export class UnsupportedAction extends PilotError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedAction";
  }
}
