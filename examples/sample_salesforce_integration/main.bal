import ballerina/http;
import ballerina/log;
import ballerina/os;
import ballerinax/salesforce;
import ballerinax/salesforce.types as sftypes;

// ── Configurable variables ───────────────────────────────────────────────────
// Resolved in this order at runtime: CLI flags → Config.toml → environment
// variable defaults. The env-var fallback means the same project runs in
// local dev (Config.toml), in containers (env vars), or in WSO2 BI runtime.

configurable string clientId        = os:getEnv("SF_CLIENT_ID");
configurable string clientSecret    = os:getEnv("SF_CLIENT_SECRET");
configurable string refreshToken    = os:getEnv("SF_REFRESH_TOKEN");
configurable string refreshUrl      = os:getEnv("SF_REFRESH_URL");
configurable string baseUrl         = os:getEnv("SF_BASE_URL");
configurable string apiVersion      = "62.0";
configurable int    servicePort     = 9090;
configurable int    maxRetries      = 3;
configurable int    retryBackoffMs  = 500;

// ── Salesforce client (shared) ───────────────────────────────────────────────
// `final` so the listener files in this package can refer to the same instance.

final salesforce:ConnectionConfig sfConfig = {
    baseUrl: baseUrl,
    auth: {
        clientId:     clientId,
        clientSecret: clientSecret,
        refreshToken: refreshToken,
        refreshUrl:   refreshUrl
    },
    apiVersion: apiVersion
};

final salesforce:Client sfClient = check new (sfConfig);

// ── HTTP listener and publishing service ────────────────────────────────────
// The "publishing" side of the sample: incoming HTTP calls map to Salesforce
// REST operations (create / get / update / delete / query).

listener http:Listener httpListener = new (servicePort);

service / on httpListener {

    # Health check. Returns 200 once the service has come up — the SF client
    # is initialised at module-init time, so a 200 here means credentials
    # passed the connector's initial validation.
    resource function get health() returns json {
        return {
            status: "UP",
            package: "wso2bi/sample_salesforce_integration",
            sf_api_version: apiVersion
        };
    }

    // ── Accounts ────────────────────────────────────────────────────────────

    resource function get accounts() returns http:Response {
        json|error result = queryAccounts();
        return result is json ? jsonResponse(result) : errorToHttpResponse(result);
    }

    resource function get accounts/[string id]() returns http:Response {
        json|error result = getAccountById(id);
        return result is json ? jsonResponse(result) : errorToHttpResponse(result);
    }

    resource function post accounts(@http:Payload sftypes:AccountSObject body)
            returns http:Response {
        json|error result = createAccount(body);
        return result is json
            ? jsonResponseWithStatus(result, 201)
            : errorToHttpResponse(result);
    }

    resource function put accounts/[string id](@http:Payload sftypes:AccountSObject body)
            returns http:Response {
        json|error result = updateAccount(id, body);
        return result is json ? jsonResponse(result) : errorToHttpResponse(result);
    }

    resource function delete accounts/[string id]() returns http:Response {
        json|error result = deleteAccount(id);
        return result is json
            ? jsonResponseWithStatus(result, 204)
            : errorToHttpResponse(result);
    }
}

// ── Response helpers ─────────────────────────────────────────────────────────

function jsonResponse(json body) returns http:Response {
    http:Response res = new;
    res.setJsonPayload(body);
    return res;
}

function jsonResponseWithStatus(json body, int status) returns http:Response {
    http:Response res = new;
    res.statusCode = status;
    if status != 204 {
        res.setJsonPayload(body);
    }
    log:printInfo("Outbound response", status = status);
    return res;
}
