import ballerina/http;
import ballerina/log;
import ballerina/lang.runtime;

// ── Domain errors ────────────────────────────────────────────────────────────
// Typed errors let us pattern-match in callers and map cleanly to HTTP responses.
// Detail records carry just enough context for the API consumer without leaking
// Salesforce internals.

public type RecordNotFoundDetail record {|
    string sobject;
    string id;
|};
public type RecordNotFound error<RecordNotFoundDetail>;

public type ValidationFailedDetail record {|
    string sobject;
    string reason;
|};
public type ValidationFailed error<ValidationFailedDetail>;

public type DuplicateRecordDetail record {|
    string sobject;
    string reason;
|};
public type DuplicateRecord error<DuplicateRecordDetail>;

public type AuthFailedDetail record {|
    string reason;
|};
public type AuthFailed error<AuthFailedDetail>;

// ── Error classification ─────────────────────────────────────────────────────

# Classifies a raw Salesforce connector error into a typed domain error.
# The connector embeds Salesforce error codes in the error message, so we
# match on substrings. Order matters: more specific patterns first.
public function classifySalesforceError(error e, string sobject, string? id = ()) returns error {
    string msg = e.message();

    if msg.includes("NOT_FOUND") || msg.includes("ENTITY_IS_DELETED") || msg.includes("MALFORMED_ID") {
        return error RecordNotFound("Record not found",
            sobject = sobject, id = id ?: "");
    }
    if msg.includes("DUPLICATE_VALUE") || msg.includes("DUPLICATES_DETECTED") {
        return error DuplicateRecord("Duplicate record",
            sobject = sobject, reason = trimDetail(msg));
    }
    if msg.includes("REQUIRED_FIELD_MISSING")
        || msg.includes("INVALID_FIELD")
        || msg.includes("FIELD_INTEGRITY_EXCEPTION")
        || msg.includes("STRING_TOO_LONG")
        || msg.includes("INVALID_TYPE") {
        return error ValidationFailed("Validation failed",
            sobject = sobject, reason = trimDetail(msg));
    }
    if msg.includes("INVALID_SESSION_ID")
        || msg.includes("invalid_grant")
        || msg.includes("invalid_client")
        || msg.includes("INSUFFICIENT_ACCESS") {
        return error AuthFailed("Salesforce auth failed",
            reason = trimDetail(msg));
    }

    // Anything else propagates as-is — the HTTP layer treats this as 5xx.
    return e;
}

# Maps a domain error to an HTTP response with an appropriate status code and
# a small JSON body that won't leak Salesforce internals.
public function errorToHttpResponse(error e) returns http:Response {
    http:Response res = new;

    if e is RecordNotFound {
        res.statusCode = 404;
        res.setJsonPayload({
            'error: "NOT_FOUND",
            sobject: e.detail().sobject,
            id: e.detail().id
        });
        return res;
    }
    if e is ValidationFailed {
        res.statusCode = 400;
        res.setJsonPayload({
            'error: "VALIDATION_FAILED",
            sobject: e.detail().sobject,
            reason: e.detail().reason
        });
        return res;
    }
    if e is DuplicateRecord {
        res.statusCode = 409;
        res.setJsonPayload({
            'error: "DUPLICATE",
            sobject: e.detail().sobject,
            reason: e.detail().reason
        });
        return res;
    }
    if e is AuthFailed {
        res.statusCode = 502;
        res.setJsonPayload({
            'error: "UPSTREAM_AUTH_FAILED",
            reason: e.detail().reason
        });
        return res;
    }

    // Unknown / unmapped — log the raw cause for the operator but show a
    // sanitized response to the caller.
    log:printError("Unhandled error", 'error = e);
    res.statusCode = 500;
    res.setJsonPayload({ 'error: "INTERNAL", message: "Unexpected error" });
    return res;
}

function trimDetail(string s) returns string {
    int len = s.length();
    if len <= 240 {
        return s;
    }
    return s.substring(0, 240) + "…";
}

// ── Retry with exponential backoff ───────────────────────────────────────────

# Retries `attempt` up to `maxAttempts` times with exponential backoff.
# Only retries on errors that look transient (rate-limit, 5xx, row lock).
# Non-transient errors (validation, not found, auth) fail fast.
public function withRetry(int maxAttempts, int initialBackoffMs,
                          function () returns json|error attempt) returns json|error {
    int delay = initialBackoffMs;
    foreach int i in 1 ... maxAttempts {
        json|error result = attempt();
        if result is json {
            return result;
        }
        if !isTransient(result) || i == maxAttempts {
            return result;
        }
        log:printWarn("Retrying transient failure",
            attempt = i, maxAttempts = maxAttempts, delayMs = delay,
            cause = result.message());
        runtime:sleep(<decimal>delay / 1000);
        delay = delay * 2;
    }
    // Unreachable, but Ballerina needs an explicit return.
    return error("retry loop exited unexpectedly");
}

function isTransient(error e) returns boolean {
    string m = e.message();
    return m.includes("REQUEST_LIMIT_EXCEEDED")
        || m.includes("SERVER_UNAVAILABLE")
        || m.includes("UNABLE_TO_LOCK_ROW")
        || m.includes("connection refused")
        || m.includes("timeout")
        || m.includes("503")
        || m.includes("504");
}
