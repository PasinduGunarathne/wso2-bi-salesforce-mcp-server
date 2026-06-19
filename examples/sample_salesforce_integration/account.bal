import ballerina/log;
import ballerinax/salesforce;
import ballerinax/salesforce.types as sftypes;

// ── Account publishing flow ──────────────────────────────────────────────────
// Each function wraps a single connector call, classifies failures into typed
// errors, and routes transient errors through `withRetry`.

# Validates incoming payload before forwarding to Salesforce. Catching
# required-field issues here gives a faster, clearer 400 than waiting for SF.
function validateAccount(sftypes:AccountSObject payload) returns ValidationFailed? {
    string? name = payload.Name;
    if name is () || name.trim() == "" {
        return error ValidationFailed("Account.Name is required",
            sobject = "Account", reason = "Name must be a non-empty string");
    }
    return ();
}

public function createAccount(sftypes:AccountSObject payload) returns json|error {
    ValidationFailed? validation = validateAccount(payload);
    if validation is ValidationFailed {
        return validation;
    }

    return withRetry(maxRetries, retryBackoffMs, function () returns json|error {
        salesforce:CreationResponse|error res = sfClient->create("Account", payload);
        if res is error {
            return classifySalesforceError(res, "Account");
        }
        log:printInfo("Account created", id = res.id);
        return { id: res.id, success: true };
    });
}

public function getAccountById(string id) returns json|error {
    sftypes:AccountSObject|error rec = sfClient->getById("Account", id);
    if rec is error {
        return classifySalesforceError(rec, "Account", id);
    }
    return rec.toJson();
}

public function updateAccount(string id, sftypes:AccountSObject payload) returns json|error {
    error? updateResult = sfClient->update("Account", id, payload);
    if updateResult is error {
        return classifySalesforceError(updateResult, "Account", id);
    }
    log:printInfo("Account updated", id = id);
    return { id: id, success: true };
}

public function deleteAccount(string id) returns json|error {
    error? deleteResult = sfClient->delete("Account", id);
    if deleteResult is error {
        return classifySalesforceError(deleteResult, "Account", id);
    }
    log:printInfo("Account deleted", id = id);
    return { id: id, success: true };
}

public function queryAccounts() returns json|error {
    string soql = "SELECT Id, Name, Industry, BillingCity FROM Account ORDER BY CreatedDate DESC LIMIT 200";
    stream<record {}, error?> resultStream = check sfClient->query(soql);

    record {}[] records = [];
    error? collectErr = from record {} rec in resultStream
        do {
            records.push(rec);
        };
    if collectErr is error {
        return classifySalesforceError(collectErr, "Account");
    }
    return records.toJson();
}
