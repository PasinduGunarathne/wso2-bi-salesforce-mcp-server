import ballerina/http;
import ballerina/log;
import ballerinax/salesforce;

// ── Account CDC listener (consuming flow) ────────────────────────────────────
// Subscribes to the /data/AccountChangeEvent channel. Salesforce dispatches a
// message whenever an Account is created, updated, deleted, or undeleted —
// and this service reacts.
//
// The channel name is the service path below — not part of the listener config.
// A separate salesforce:Listener instance is required per channel when OAuth2
// coordination is active.
//
// Reuses the OAuth2 credentials initialised in main.bal. Errors thrown by any
// callback are logged by the listener and the message is acknowledged so the
// channel keeps flowing.

salesforce:RestBasedListenerConfig accountCdcConfig = {
    auth: <http:OAuth2RefreshTokenGrantConfig>{
        clientId:     clientId,
        clientSecret: clientSecret,
        refreshToken: refreshToken,
        refreshUrl:   refreshUrl
    },
    baseUrl: baseUrl
};

listener salesforce:Listener accountCdcListener = new (accountCdcConfig);

service "/data/AccountChangeEvent" on accountCdcListener {

    remote function onCreate(salesforce:EventData event) returns error? {
        do {
            log:printInfo("Account created (CDC)", payload = event.changedData);
        } on fail error e {
            log:printError("Unhandled error in onCreate", 'error = e);
        }
    }

    remote function onUpdate(salesforce:EventData event) returns error? {
        do {
            // CDC payloads only include changed fields, so any field may be
            // missing. Pull each one defensively.
            log:printInfo("Account updated (CDC)", changed = event.changedData);

            json? industry = event.changedData["Industry"];
            if industry !is () {
                log:printInfo("Account Industry changed", industry = industry);
                // forwardToDownstream(industry) — wire your own integration here.
            }
        } on fail error e {
            log:printError("Unhandled error in onUpdate", 'error = e);
        }
    }

    remote function onDelete(salesforce:EventData event) returns error? {
        do {
            log:printInfo("Account deleted (CDC)", payload = event.changedData);
        } on fail error e {
            log:printError("Unhandled error in onDelete", 'error = e);
        }
    }

    remote function onRestore(salesforce:EventData event) returns error? {
        do {
            log:printInfo("Account restored (CDC)", payload = event.changedData);
        } on fail error e {
            log:printError("Unhandled error in onRestore", 'error = e);
        }
    }
}
