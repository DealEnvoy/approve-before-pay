// Live PayPal sandbox check. Requires PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.
// Creates an order, reads it, then captures it. Prints ids and statuses. Does not print secrets.

const clientId = process.env.PAYPAL_CLIENT_ID?.trim() ?? "";
const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim() ?? "";
const base = (process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com").replace(/\/$/, "");

if (!clientId || !clientSecret) {
  console.error("sandbox:smoke needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET. Mock mode is not used here.");
  process.exit(1);
}

const cardNumber = process.env.PAYPAL_TEST_CARD_NUMBER?.trim() || "4012000033330026";
const cardExpiry = process.env.PAYPAL_TEST_CARD_EXPIRY?.trim() || "2030-12";
const cardCvv = process.env.PAYPAL_TEST_CARD_CVV?.trim() || "123";

const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
const tokenResponse = await fetch(`${base}/v1/oauth2/token`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});
const tokenBody = await tokenResponse.json().catch(() => ({}));
if (!tokenResponse.ok || !tokenBody.access_token) {
  console.error(`OAuth failed. HTTP ${tokenResponse.status}. ${tokenBody.error_description || tokenBody.error || "No access token."}`);
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${tokenBody.access_token}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

const createResponse = await fetch(`${base}/v2/checkout/orders`, {
  method: "POST",
  headers: { ...headers, "PayPal-Request-Id": `smoke-create-${Date.now()}` },
  body: JSON.stringify({
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: "default",
        description: "Approve before Pay sandbox smoke",
        custom_id: "sandbox-smoke",
        amount: { currency_code: "USD", value: "1.00" },
      },
    ],
  }),
});
const created = await createResponse.json().catch(() => ({}));
if (!createResponse.ok || !created.id) {
  console.error(`Create failed. HTTP ${createResponse.status}. ${created.name || ""} ${created.message || ""}`.trim());
  process.exit(1);
}
console.log(`create order_id=${created.id} status=${created.status || "unknown"} intent=${created.intent || "CAPTURE"}`);

const readResponse = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(created.id)}`, { headers });
const read = await readResponse.json().catch(() => ({}));
if (!readResponse.ok) {
  console.error(`Read failed. HTTP ${readResponse.status}. ${read.name || ""} ${read.message || ""}`.trim());
  process.exit(1);
}
console.log(`read order_id=${read.id || created.id} status=${read.status || "unknown"}`);

const captureResponse = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(created.id)}/capture`, {
  method: "POST",
  headers: { ...headers, "PayPal-Request-Id": `smoke-capture-${Date.now()}` },
  body: JSON.stringify({
    payment_source: {
      card: {
        number: cardNumber,
        expiry: cardExpiry,
        security_code: cardCvv,
        name: "Test Buyer",
        billing_address: {
          address_line_1: "1 Main St",
          admin_area_2: "San Jose",
          admin_area_1: "CA",
          postal_code: "95131",
          country_code: "US",
        },
      },
    },
  }),
});
const captured = await captureResponse.json().catch(() => ({}));
const capture = captured.purchase_units?.[0]?.payments?.captures?.[0];
if (!captureResponse.ok) {
  console.error(`Capture failed. HTTP ${captureResponse.status}. order_id=${created.id} name=${captured.name || ""} message=${captured.message || ""}`.trim());
  process.exit(1);
}
console.log(
  `capture order_id=${captured.id || created.id} order_status=${captured.status || "unknown"} capture_id=${capture?.id || ""} capture_status=${capture?.status || ""}`,
);
if (captured.status !== "COMPLETED") {
  console.error(`Capture did not complete. order_id=${created.id} order_status=${captured.status || "unknown"}`);
  process.exit(1);
}
