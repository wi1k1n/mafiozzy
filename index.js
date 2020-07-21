const webSocket = require('ws');
const crypto = require('crypto')

const USERID_LENGTH = 16;
const BROWSERINSTANCEID_LENGTH = 4;
const DEBUG = true;
const TEAMS = ['spec', 'player'];

var rooms = {};
var users = {};


const wss = new webSocket.Server({ port: 6001 });
wss.on('listening', function listening() {
    console.log('Server started on port %s', this.options.port);
});

wss.on('connection', function connection(ws, rq) {
    let biidAndRID = parseWebsocketProtocol(rq.headers);
    if (!biidAndRID || biidAndRID.length !== 2) {
        console.warn('Invalid websocket protocol value!');
        ws.close(1002, 'Invalid websocket protocol value. Must consist of roomID and biID!');
        return;
    }
    let biID = biidAndRID[0];
    let roomID = biidAndRID[1];
    let connectionID = getConnectionHash(rq.headers);
    if (DEBUG) console.log('[dbg] #' + connectionID + ' connected to room #'+roomID+' with headers:\n' + JSON.stringify(rq.headers));
    // Add new connection to user list and terminate previous connection if there was one
    if (!users.hasOwnProperty(connectionID))
        users[connectionID] = new User(connectionID);
    else
        users[connectionID].ws.close(4001, 'Another connection for this user was created!');
    users[connectionID].ws = ws;
    if (!rooms.hasOwnProperty(roomID)) rooms[roomID] = new Room(roomID, {}, connectionID);
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

        if ('jn' === cmd) {
            // Join room request
            if (userID in rooms[roomID].players)
                return sendJSON({cmd: 'jn', code: 42, msg: 'Already in room'});
            if (rooms[roomID].locked)
                return sendJSON({cmd: 'jn', code: 43, msg: 'This room is locked ATM'});
            rooms[roomID].players[userID] = new Player(userID, 'spec', -1, null);
                // Object.values(rooms[roomID].players).filter(p => p.team === 'player').length+1, null);
            sendJSON({cmd: 'jn', code: 40});
            els(roomID, userID, 62);
            return;
        } else if ('ls' === cmd) {
            // List of players requested
            if (!rooms.hasOwnProperty(roomID))
                return sendJSON({cmd: 'ls', code: 31, msg: 'No room found'});
            return sendJSON({cmd: 'ls', code: 30, data: prepareListOfUsers(roomID)});
        } else if ('tm' === cmd) {
            // Change of team requested
            if (!msg.hasOwnProperty('team'))
                return sendJSON({cmd: 'tm', code: 71, msg: 'Team not specified'});
            if (!TEAMS.some(e => e === msg.team))
                return sendJSON({cmd: 'tm', code: 72, msg: 'Invalid team requested'});
            rooms[roomID].players[userID].team = msg.team;
            // Handle numbers
            let players = [...Object.values(rooms[roomID].players).filter(p => p.team === 'player')];
            players.sort((a, b) => a.number < b.number ? -1 : (a.number > b.number ? 1 : 0));
            for (let i = 0; i < players.length; i++)
                rooms[roomID].players[players[i].uid].number = i + 1;

            sendJSON({cmd: 'tm', code: 70});
            els(roomID, userID, 64);
            return;
        } else if ('cn' === cmd) {
            // Change numbers of players requested
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'cn', code: 81, msg: 'You are not host of room'});
            if (!msg.hasOwnProperty('data'))
                return sendJSON({cmd: 'cn', code: 82, msg: 'Data not specified'});
            msg.data.forEach(function(p) {
                rooms[roomID].players[p.uid].number = p.number;
            });
            sendJSON({cmd: 'cn', code: 80});
            els(roomID, userID, 65);
            return;
        }
        return;
    });

    function els(roomID, exceptUID, code) {
        // Codes:
        // 62 - user joined
        // 63 - name changed
        // 64 - team changed

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
            let p = rooms[roomID].players[uid];
            if (!p.hasOwnProperty('name') || !p.name)
                p.name = p.uid;
            obj.players.push(p);
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
    function Player(uid, team, number, role) {
        if (!uid) console.warn('[Player] Invalid userID! Something goes wrong!');
        this.uid = uid ? uid : null;
        this.team = team ? team : 'spec';
        this.name = uid in users ? users[uid].name : '';
        this.role = role ? role : null;
        this.number = number ? number : -1;
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
function parseWebsocketProtocol(headers) {
    if (!headers.hasOwnProperty('sec-websocket-protocol')) return null;
    let protocol = headers['sec-websocket-protocol'];
    if (protocol.length <= BROWSERINSTANCEID_LENGTH) return null;
    return [protocol.substring(0, BROWSERINSTANCEID_LENGTH), protocol.substring(BROWSERINSTANCEID_LENGTH)];
}
function validateChatID(chatID) {
    console.warn('TODO: chatID validation');
    return chatID;
}
function validateName(name) {
    console.warn('TODO: name validation');
    return name;
}