const webSocket = require('ws');
const crypto = require('crypto')

const USERID_LENGTH = 16;
const DEBUG = true;

var rooms = {};
var users = {};


const wss = new webSocket.Server({ port: 6001 });
wss.on('listening', function listening() {
    console.log('Server started on port %s', this.options.port);
});

wss.on('connection', function connection(ws, rq) {
    // Client => Server requests:
    // id: => request user id
    // nm: => set user name
    // cr:userID:roomID => create room
    // jn:userID:roomID => join room
    // ls:userID => list of players
    //
    // Server => Client responses:
    // er:erCode:erMsg => error
    // id: => responds with user id
    // cr:responseID[:responseMsg]
    //
    // Returning codes:
    // err: 00-09
    // id: 10-19
    // cr: 20-29
    // ls: 30-39
    // jn: 40-49
    // nm: 50-59
    let connectionID = getConnectionHash (rq.headers);
    if (DEBUG) console.log('[dbg] #' + connectionID + ' connected with headers:\n' + JSON.stringify(rq.headers));
    // Add new connection to user list and terminate previous connection if there was one
    if (!users.hasOwnProperty(connectionID))
        users[connectionID] = new User(connectionID);
    else
        users[connectionID].ws.close(4001, 'Another connection for this user created!');
    users[connectionID].ws = ws;
    ws.on('message', function incoming(msgRaw) {
        if (DEBUG) console.log('[dbg] << ' + msgRaw);
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
            return sendJSON({cmd: 'id', code: 10, uid: connectionID});
        }

        // Check received userID
        let userID = null;
        if (msg.hasOwnProperty('uid'))
            userID = msg.uid;
        // Return error if userID is not specified
        if (!userID || !users.hasOwnProperty(userID))
            return sendJSON({cmd: 'err', code: 1, msg: 'UserID is not found. Use "id" command to get your userID.'});

        // User set his name
        if ('nm' === cmd) {
            if (!msg.hasOwnProperty('name'))
                return sendJSON({cmd: 'nm', code: 51, msg: 'Name field is not specified'});
            if (!validateName(msg.name))
                return sendJSON({cmd: 'nm', code: 52, msg: 'Invalid name'});
            if (users[userID].name === msg.name)
                return sendJSON({cmd: 'nm', code: 53, msg: 'Your current name is already the same'});
            let name = msg.name;
            users[userID].name = name;
            Object.keys(rooms).forEach(function(rid) {
                if (rooms[rid].players.hasOwnProperty(userID))
                    rooms[rid].players[userID].name = name;
            });
            sendJSON({cmd: 'nm', code: 50});
            els(null, userID, 63);
            return;
        }

        // Check received roomID
        let roomID = null;
        if (msg.hasOwnProperty('rid'))
            roomID = msg.rid;
        // Return error if roomID is not specified or invalid
        if (!roomID || !validateChatID(roomID))
            return sendJSON({cmd: 'err', code: 2, msg: 'RoomID is not specified or invalid.'});

        if ('cr' === cmd) {
            // New room requested
            if (rooms.hasOwnProperty(roomID))
                return sendJSON({cmd: 'cr', code: 21, msg: 'This roomID is already in use. Use "jn:" command to request to join'});
            rooms[roomID] = new Room(roomID, {}, userID);
            return sendJSON({cmd: 'cr', code: 20});
        } else if ('jn' === cmd) {
            // Join room request
            let roomID = null;
            if (msg.hasOwnProperty('rid'))
                roomID = msg.rid;
            if (!rooms.hasOwnProperty(roomID))
                return sendJSON({cmd: 'jn', code: 41, msg: 'No room found'});
            if (userID in rooms[roomID].players)
                return sendJSON({cmd: 'jn', code: 42, msg: 'Already in room'});
            if (rooms[roomID].locked)
                return sendJSON({cmd: 'jn', code: 43, msg: 'This room is locked ATM'});
            rooms[roomID].players[userID] = new Player(userID, 'spec');
            console.warn('[TODO] Disconnect every other connection except this one');
            sendJSON({cmd: 'jn', code: 40});
            els(roomID, userID, 62);
        } else if ('ls' === cmd) {
            // List of players requested
            if (!rooms.hasOwnProperty(roomID))
                return sendJSON({cmd: 'ls', code: 31, msg: 'No room found'});
            return sendJSON({cmd: 'ls', code: 30, data: prepareListOfUsers(roomID)});
        }
    });

    function els(roomID, exceptUID, code) {
        // Broadcast new list of players, when something changes
        exceptUID = exceptUID ? exceptUID : null;
        code = code ? code : 61;
        // Broadcast only to users of room with roomID, if roomID is specified
        if (roomID) {
            Object.keys(rooms[roomID].players).forEach(function(uid) {
                if (uid !== exceptUID)
                    sendJSON({cmd: 'els', code: code, data: prepareListOfUsers(roomID)}, users[uid].ws);
            });
            return;
        }
        // Broadcast to every room, where exceptUID participates
        Object.keys(rooms).forEach(function(rid) {
            Object.keys(rooms[rid].players).forEach(function(uid) {
                if (rooms[rid].players.hasOwnProperty(exceptUID) && uid !== exceptUID)
                    sendJSON({cmd: 'els', code: code, data: prepareListOfUsers(rid)}, users[uid].ws);
            });
        });
    }
    function prepareListOfUsers(roomID) {
        let obj = {
            players: [],
            host: rooms[roomID].host
        };
        for (let uid in rooms[roomID].players) {
            obj.players.push(rooms[roomID].players[uid]);
        }
        return obj;
    }

    function sendJSON(json, wsock) {
        wsock = wsock ? wsock : ws;
        json['timestamp'] = new Date().getTime();
        console.log('[dbg] >> ' + JSON.stringify(json));
        wsock.send(JSON.stringify(json));
    }

    function Room(rid, players, host, locked) {
        if (!rid) console.warn('[Room] Invalid roomID! Something goes wrong!');
        this.roomID = rid;
        this.players = players ? players : {};
        this.host = host ? host : null;
        this.locked = locked ? locked : false;
    }
    function User(uid, ws, name) {
        if (!uid) console.warn('[User] Invalid userID! Something goes wrong!');
        this.uid = uid;
        this.ws = ws ? ws : null;
        this.name = name ? name.toString() : '';
    }
    function Player(uid, rid, team) {
        if (!uid) console.warn('[Player] Invalid userID! Something goes wrong!');
        this.uid = uid ? uid : null;
        this.team = team ? team : 'spec';
        this.name = uid in users ? users[uid].name : '';
    }
});

function getConnectionHash(headers) {
    let postfix = '';
    if (headers.hasOwnProperty('sec-websocket-protocol'))
        postfix = headers['sec-websocket-protocol'];
    return crypto.createHash('md5')
        .update(headers['origin'] + '=>' + headers['user-agent'] + postfix)
        .digest("hex").substring(0, USERID_LENGTH);
}
function validateChatID(chatID) {
    console.warn('TODO: chatID validation');
    return chatID;
}
function validateName(name) {
    console.warn('TODO: name validation');
    return name;
}