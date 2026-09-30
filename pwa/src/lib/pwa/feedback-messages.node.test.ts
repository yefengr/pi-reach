import { expect, test } from "vitest";
import { safeConfirmationError, safeFeedbackMessage, safeProtocolFeedbackMessage } from "./feedback-messages";

test.each([
  "DOMException: IndexedDB failed",
  "WebSocket Relay endpoint_id=550e8400-e29b-41d4-a716-446655440000",
  "protocol_version channel_id leaf_id",
  "Choose a PNG, JPEG, or WebP image. INTERNAL_TOKEN",
  "__proto__",
  "constructor",
])("never renders unknown exception text: %s", (message) => {
  expect(safeFeedbackMessage(message)).toBe("Something went wrong. Try again.");
  expect(safeFeedbackMessage(message, "history")).toBe("Could not load the conversation. Try again.");
  expect(safeFeedbackMessage(message, "timeline")).toBe("Could not update the conversation. Reconnect and try again.");
  expect(safeFeedbackMessage(message, "pairing")).toBe("Could not pair with Pi. Check the code and try again.");
  expect(safeFeedbackMessage(message, "image")).toBe("Could not prepare that image. Choose another image and try again.");
  expect(safeFeedbackMessage(message, "message-send")).toBe("Could not send this message. Try again.");
  expect(safeFeedbackMessage(message, "protocol")).toBe("Pi could not process this request. Try again.");
  expect(safeFeedbackMessage(message, "local-history")).toBe("Could not update local history.");
});

test("retains actionable known input feedback through the final Toast boundary", () => {
  for (const message of [
    "Choose a PNG, JPEG, or WebP image.",
    "This transparent PNG is too large to send.",
    "That pairing code has expired. Generate a new code on the Pi.",
    "Could not read saved conversations.",
    "Too many unconfirmed messages or attachments. Wait for delivery confirmation before sending more.",
    "Too many queued messages or attachments. Existing messages were kept. Reconnect after the queue gets smaller.",
  ]) expect(safeFeedbackMessage(safeFeedbackMessage(message))).toBe(message);
  expect(safeFeedbackMessage("Relay is not connected.")).toBe("Message could not be sent. Check the connection and try again.");
  expect(safeFeedbackMessage("This browser cannot prepare image attachments.")).not.toMatch(/browser/);
  expect(safeFeedbackMessage(null)).toBeNull();
  expect(safeFeedbackMessage("")).toBeNull();
});

test.each([
  ["invalid_channel", "This session is out of date. Reconnect and try again."],
  ["reset_required", "This session is out of date. Reconnect and try again."],
  ["invalid_leaf", "This session is out of date. Reconnect and try again."],
  ["too_large", "This message is too large to send."],
  ["unsupported_type", "This operation is not supported. Update Pi and try again."],
  ["invalid_message", "Pi rejected this message. Check it and try again."],
  ["internal_error", "Pi could not process this request. Try again."],
  ["unknown-code", "Pi could not process this request. Try again."],
  ["__proto__", "Pi could not process this request. Try again."],
  ["constructor", "Pi could not process this request. Try again."],
])("classifies protocol code %s and survives the final Toast boundary", (code, message) => {
  expect(safeProtocolFeedbackMessage(code)).toBe(message);
  expect(safeFeedbackMessage(safeProtocolFeedbackMessage(code))).toBe(message);
});

test("keeps send and local-history feedback specific through the final Toast boundary", () => {
  expect(safeFeedbackMessage(safeFeedbackMessage("unrecognized send error", "message-send"))).toBe("Could not send this message. Try again.");
  expect(safeFeedbackMessage(safeFeedbackMessage("Local timeline changed unexpectedly.", "local-history"))).toBe("This conversation changed elsewhere. Reconnect and try again.");
  expect(safeFeedbackMessage(safeFeedbackMessage("unrecognized storage error", "local-history"))).toBe("Could not update local history.");
});

test("confirmation failures are described by action rather than exception text", () => {
  expect(safeConfirmationError("new-session")).toBe("Could not start a fresh session. Check the connection and try again.");
  expect(safeConfirmationError("remove-pairing")).toBe("Could not delete pairing. Try again.");
  expect(safeConfirmationError("clear-local-data")).toBe("Could not clear local data. Try again.");
});
