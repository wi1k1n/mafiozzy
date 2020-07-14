const webSocket = require('ws');
const crypto = require('crypto')

const USERID_LENGTH = 16;

var rooms = {};
var users = {};


const wss = new webSocket.Server({ port: 6001 });
wss.on('listening', function listening() {
    console.log('Server started on port %s', this.options.port);
});

wss.on('connection', function connection(ws, rq) {
    // Client => Server requests:
    // id: => request user id
    // cr:userID:roomID => create room
    // jn:userID:roomID => join room
    // ls:userID => list of players
    //
    // Server => Client responses:
    // er:erCode:erMsg => error
    // id: => responds with user id
    // cr:responseID[:responseMsg]
    let connectionID = getConnectionHash (rq.headers);
    ws.on('message', function incoming(msgRaw) {
        let msg = null;
        try {
            msg = JSON.parse(msgRaw);
        } catch (e) {
            return console.warn('Could not parse client request: ' + msgRaw);
        }

        // Server response must contain 'cmd' field
        if (!msg.hasOwnProperty('cmd'))
            return console.warn('Invalid client request: ' + msgRaw);
        let cmd = msg.cmd;

        // User requested id
        if ('id' === cmd) {
            if (!users.hasOwnProperty(connectionID))
                users[connectionID] = {};
            return sendJSON({cmd: 'id', code: 10, uid: connectionID});
        }

        // Check received userID
        let userID = null;
        if (msg.hasOwnProperty('uid'))
            userID = msg.uid;
        // Return error if userID is not specified
        if (!userID || !users.hasOwnProperty(userID))
            return sendJSON({cmd: 'err', code: 1, msg: 'UserID is not found. User "id" command to get your userID.'});
        let roomID = null;
        if (msg.hasOwnProperty('rid'))
            roomID = msg.rid;
        // Return error if roomID is not specified or invalid
        if (!roomID || !validateChatID(roomID))
            return sendJSON({cmd: 'err', code: 2, msg: 'RoomID is not specified or invalid.'});

        if ('cr' === cmd) {
            // New room requested
            let roomID = null;
            if (msg.hasOwnProperty('rid'))
                roomID = msg.rid;
            if (!validateChatID(roomID))
                return sendJSON({cmd: 'cr', code: 21, msg: 'Invalid RoomID'});
            if (rooms.hasOwnProperty(roomID))
                return sendJSON({
                    cmd: 'cr',
                    code: 22,
                    msg: 'This roomID is already in use. Use "jn:" command to request to join'
                });
            rooms[roomID] = {
                'users': [],
                'locked': false
            };
            return sendJSON({cmd: 'cr', code: 20});
        } else if ('jn' === cmd) {
            // Join room request
            let roomID = null;
            if (msg.hasOwnProperty('rid'))
                roomID = msg.rid;
            if (!validateChatID(roomID))
                return sendJSON({cmd: 'jn', code: 41, msg: 'Invalid RoomID'});
            if (!rooms.hasOwnProperty(roomID))
                return sendJSON({cmd: 'jn', code: 42, msg: 'No room found'});
            if (rooms[roomID].users.some(uid => uid === userID))
                return sendJSON({cmd: 'jn', code: 43, msg: 'Already in room'});
            if (rooms[roomID].locked)
                return sendJSON({cmd: 'jn', code: 44, msg: 'This room is locked ATM'});
            users[userID].room = roomID;
            users[userID].team = 'spec';
            rooms[roomID].users.push(userID);
            return sendJSON({cmd: 'jn', code: 40});
        } else if ('ls' === cmd) {
            // List of players requested
            // Find room of current user
            let roomID = users[userID].room;
            let obj = {
                spec: [],
                player: [],
                playerInfo: {}
            };
            rooms[roomID]['users'].forEach(function(uid) {
                obj[users[uid].team].push(uid);
                obj.playerInfo[uid] = {name: ''};
            });
            return sendJSON({cmd: 'ls', code: 30, data: obj});
        }
    });
    console.log('New connection from: %s', rq.headers.origin);
    function sendJSON(json) {
        json['timestamp'] = new Date().getTime();
        ws.send(JSON.stringify(json));
    }
});

function getConnectionHash(headers) {
    return crypto.createHash('md5')
        .update(headers['origin'] + '=>' + headers['user-agent'])
        .digest("hex").substring(0, USERID_LENGTH);
}
function validateChatID(chatID) {
    console.warn('TODO: chatID validation');
    return chatID;
}