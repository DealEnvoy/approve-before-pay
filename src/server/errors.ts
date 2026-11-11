export class GateError extends Error {
  readonly extra?: Record<string, unknown>;

  constructor(
    public code: string,
    public status: number,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GateError";
    this.extra = extra;
  }
}

export class PayPalRequestError extends Error {
  constructor(
    public httpStatus: number,
    public paypalName: string,
    message: string,
  ) {
    super(message);
    this.name = "PayPalRequestError";
  }
}
