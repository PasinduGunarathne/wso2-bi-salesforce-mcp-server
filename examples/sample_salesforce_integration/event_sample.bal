import ballerina/log;
import ballerinax/salesforce;

// ── Platform Event listener (consuming flow) ────────────────────────────────
// Demonstrates consuming a Salesforce Platform Event. Create the event in
// Salesforce Setup → Platform Events with API name "Sample_Event__e" and a
// few custom fields, or rename the channel to match your own platform event.
//
// Comment out this listener if you don't have a matching platform event in
// your org — Ballerina will fail at startup if the channel doesn't exist.

listener salesforce:Listener sampleEventListener = new ({
    auth: {
        clientId:     clientId,
        clientSecret: clientSecret,
        refreshToken: refreshToken,
        refreshUrl:   refreshUrl
    },
    baseUrl: baseUrl,
    channelName: "/event/Sample_Event__e"
});

service salesforce:PlatformEventsService on sampleEventListener {

    remote function onMessage(salesforce:PlatformEventsMessage message) returns error? {
        do {
            log:printInfo("Platform event received",
                channel = "/event/Sample_Event__e",
                payload = message.payload);

            // Example downstream handling. Wrap in a do/on-fail block so a
            // single bad event doesn't tear down the listener service.
            // forwardToDownstream(message.payload);

        } on fail error e {
            log:printError("Platform event handling failed",
                'error = e,
                channel = "/event/Sample_Event__e");
            // Swallow — the listener will continue consuming subsequent events.
        }
    }
}
