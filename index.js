var mqtt = require('mqtt')
var fs = require('fs');
const AWS = require('aws-sdk');
var dynamodb = new AWS.DynamoDB();

function log(title, msg) {
    console.log(`[${title}] ${msg}`);
}

function generateMessageID() {
    return '38A28869-DD5E-48CE-BBE5-A4DB78CECB28';
}

function generateResponse(name, endpointId, payload, corrToken) {
    return {
        event: {
            header: {
                namespace: "Alexa",
                name: name,
                payloadVersion: "3",
                messageId: generateMessageID(),
                correlationToken: corrToken
            },
            endpoint: {
                endpointId: endpointId
            },
            payload: payload
        }
    };
}

function isValidToken() {
    return true;
}

function isDeviceOnline(applianceId) {
    log('DEBUG', `isDeviceOnline (applianceId: ${applianceId})`);
    return true;
}

function handleDiscovery(request, callback) {
    log('DEBUG', `Discovery Request: ${JSON.stringify(request)}`);

    const userAccessToken = request.directive.payload.scope.token.trim();

    if (!userAccessToken || !isValidToken(userAccessToken)) {
        const errorMessage = `Discovery Request [${request.event.header.messageId}] failed. Invalid access token: ${userAccessToken}`;
        log('ERROR', errorMessage);
        callback(new Error(errorMessage));
    }

    const response = {
        event: {
            header:{
                namespace: "Alexa.Discovery",
                name: "Discover.Response",
                payloadVersion: "3",
                messageId: generateMessageID()
            },
            payload: {
                endpoints: [],
            },
        }
    };

    var params = {
        ExpressionAttributeValues: {
            ":at": {
                S: userAccessToken
            },
        },
        FilterExpression: "access_token = :at",
        TableName: "MQTThomeUsers"
    };


    dynamodb.scan(params, function(err, data) {
        if (err) {
            console.log(err)
            callback(new Error("access denied"))
        } else {
            if(data["Count"] != 0) {
                var devices = data.Items[0].devices.M
                console.log(JSON.stringify(devices))
                for(var i = 0; i < Object.keys(devices).length; i++) {
                    var device = devices["device" + i]
                    console.log(JSON.stringify(device))
                    var endpoint = {
                        "endpointId": "device" + i,
                        "manufacturerName": "MQTT Home",
                        "friendlyName": device.M.name.S,
                        "description": "MQTT Home",
                        "displayCategories": [
                            device.M.type.S
                        ],
                        "capabilities": [
                            {
                                "type": "AlexaInterface",
                                "interface": "Alexa",
                                "version": "3"
                            },
                            {
                                "type": "AlexaInterface",
                                "interface": "Alexa.PowerController",
                                "version": "3",
                                "properties": {
                                    "supported": [
                                        {
                                            "name": "powerState"
                                        }
                                    ],
                                    "proactivelyReported": false,
                                    "retrievable": false
                                }
                            }
                        ]
                    }

                    response.event.payload.endpoints.push(endpoint)
                }
                callback(null, response);
            } else {
                console.log("couldnt find access token: " + userAccessToken )
                callback(new Error("access denied"))
            }
        }
    });


}

function handlePowerControl(request, callback) {
    log('DEBUG', `Control Request: ${JSON.stringify(request)}`);


    const userAccessToken = request.directive.endpoint.scope.token.trim();

    if (!userAccessToken || !isValidToken(userAccessToken)) {
        log('ERROR', `Discovery Request [${request.directive.header.messageId}] failed. Invalid access token: ${userAccessToken}`);
        callback(null, generateResponse('InvalidAccessTokenError', applianceId, {}, request.directive.header.correlationToken));
        return;
    }

    const applianceId = request.directive.endpoint.endpointId;

    if (!applianceId) {
        log('ERROR', 'No applianceId provided in request');
        const payload = { faultingParameter: `applianceId: ${applianceId}` };
        callback(null, generateResponse('UnexpectedInformationReceivedError', applianceId, payload, request.directive.header.correlationToken));
        return;
    }

    if (!isDeviceOnline(applianceId, userAccessToken)) {
        log('ERROR', `Device offline: ${applianceId}`);
        callback(null, generateResponse('TargetOfflineError', applianceId, {}, request.directive.header.correlationToken));
        return;
    }

    let response;

    var params = {
        ExpressionAttributeValues: {
            ":at": {
                S: userAccessToken
            },
        },
        FilterExpression: "access_token = :at",
        TableName: "MQTThomeUsers"
    };


    dynamodb.scan(params, function(err, data) {
        if (err) {
            console.log(err)
            callback(new Error("access denied"))
        } else {
            if(data["Count"] != 0) {
                var devices = data.Items[0].devices.M
                console.log(JSON.stringify(devices))
                var device = devices[applianceId]
                switch (request.directive.header.name) {
                    case 'TurnOn':
                        sendMQTT(device.M.address.S, device.M.port.S, device.M.topic.S, device.M.onMessage.S, function(err) {
                            if(err) {
                                console.log(err)
                                callback(null, generateResponse('ErrorResponse', applianceId, { "type" : "ENDPOINT_UNREACHABLE" }, request.directive.header.correlationToken));
                            } else {
                                response = generateResponse("Response", applianceId, {}, request.directive.header.correlationToken)
                                callback(null, response);
                            }
                        })
                        break;
            
                    case 'TurnOff':
                        sendMQTT(device.M.address.S, device.M.port.S, device.M.topic.S, device.M.offMessage.S, function(err) {
                            if(err) {
                                console.log(err)
                                callback(null, generateResponse('ErrorResponse', applianceId, { "type" : "ENDPOINT_UNREACHABLE" }, request.directive.header.correlationToken));
                            } else {
                                response = generateResponse("Response", applianceId, {}, request.directive.header.correlationToken)
                                callback(null, response);
                            }
                        })
                        break;
            
                    default: {
                        log('ERROR', `No supported directive name: ${request.directive.header.name}`);
                        callback(null, generateResponse('ErrorResponse', applianceId, { "type" : "ENDPOINT_UNREACHABLE" }, request.directive.header.correlationToken));
                        return;
                    }
                }
                
            } else {
                console.log("couldnt find access token: " + userAccessToken )
                callback(null, generateResponse('ErrorResponse', applianceId, { "type" : "ENDPOINT_UNREACHABLE" }, request.directive.header.correlationToken));
            }
        }
    });

    log('DEBUG', `Control Confirmation: ${JSON.stringify(response)}`);

}

exports.handler = (event, context, callback) => {
    log('REQUEST', `Control Confirmation: ${JSON.stringify(event)}`);
    switch (event.directive.header.namespace) {
        case 'Alexa.Discovery':
            handleDiscovery(event, callback);
            break;
        case 'Alexa.PowerController':
            handlePowerControl(event, callback);
            break;
        default: {
            const errorMessage = `No supported namespace: ${event.directive.header.namespace}`;
            log('ERROR', errorMessage);
            callback(new Error(errorMessage));
        }
    }
};

function sendMQTT(address, port, topic, message, callback) {

    var connectOptions = {
        servers: [
            {
                host: address,
                port: parseInt(port),
            }
        ],
        protocol: "mqtt",
        clientId: "MQTT Home",
        rejectUnauthorized: false,
    };

    var client = mqtt.connect(connectOptions);

    client.on('connect', function () {
      client.publish(topic, message, function(err) {
          if(err) {
              console.log(err)
              callback(err)
          } else {
              callback(null)
          }
          client.end()
      })
    })
    
    client.on('offline', function () {
        client.end()
        callback(new Error("offline"))
    })
}
