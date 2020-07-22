const webSocket = require('ws');

let srv = null;
module.exports = {
    websocketServer: function (port) {
        srv = new webSocket.Server({ port: port });
        return srv;
    },
    listen: function () {
        return;
    }
};