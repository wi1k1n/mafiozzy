const argv = require('optimist')
    .usage('Usage: $0 -port [num] -wss -debug')
    .argv;
const crypto = require('crypto');

let webSocket = null;
if (argv.wss) websocket = require('./websocketHTTPS');
else websocket = require('./websocket');

const PORT = argv.port ? parseInt(argv.port) : 6001;
const USERID_LENGTH = 16;
const BROWSERINSTANCEID_LENGTH = 4;
const DEBUG = argv.debug ? true : false;
const TEAMS = ['spec', 'player'];

let rooms = {};
let users = {};

// const wss = new webSocket.Server({ port: 6001 });
const wss = websocket.websocketServer(PORT);
wss.on('listening', function listening() {
    console.log('Server started on port %s', PORT);
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
            if (userID in rooms[roomID].players) {
                rooms[roomID].players[userID].dc = false;
                sendJSON({cmd: 'jn', code: 42, msg: 'Already in room'});
                els(roomID, userID, 62);
                return;
            }
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
            if (!(userID in rooms[roomID].players))
                return sendJSON({cmd: 'tm', code: 73, msg: 'You are not in the room'});
            if (rooms[roomID].playing)
                return sendJSON({cmd: 'tm', code: 74, msg: 'The game is in process ATM.'});
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
        } else if ('cr' === cmd) {
            // Change roles of players requested
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'cr', code: 91, msg: 'You are not the host of room'});
            if (!msg.hasOwnProperty('data'))
                return sendJSON({cmd: 'cr', code: 92, msg: 'Data not specified'});
            msg.data.forEach(function(p) {
                rooms[roomID].players[p.uid].role = p.role;
            });
            sendJSON({cmd: 'cr', code: 90});
            els(roomID, userID, 66);
            return;
        } else if ('kl' === cmd) {
            // Player requested to kill player
            if (!(userID in rooms[roomID].players))
                return sendJSON({cmd: 'kl', code: 107, msg: 'You are not in the room'});
            let killer = rooms[roomID].players[userID];
            if (killer.team !== 'player')
                return sendJSON({cmd: 'kl', code: 101, msg: 'You are not playing ATM.'});
            if (killer.status !== 'playing')
                return sendJSON({cmd: 'kl', code: 105, msg: 'You have already been killed.'});
            if (!msg.hasOwnProperty('puid'))
                return sendJSON({cmd: 'kl', code: 102, msg: 'puid field not specified'});
            let killed = rooms[roomID].players[msg.puid];
            if (killed.team !== 'player')
                return sendJSON({cmd: 'kl', code: 103, msg: 'Player you r killing is not playing ATM.'});
            if (killed.status !== 'playing')
                return sendJSON({cmd: 'kl', code: 106, msg: 'Player you r killing has already been killed.'});

            let mbs = Object.keys(rooms[roomID].players).filter(puid => {
                let cp = rooms[roomID].players[puid];
                return cp.role === 'MafiaBoss' && cp.status === 'playing';
            });
            let mfs = Object.keys(rooms[roomID].players).filter(puid => {
                let cp = rooms[roomID].players[puid];
                return cp.role === 'Mafia' && cp.status !== 'killed';
            });

            if (killer.role !== 'MafiaBoss') {
                if (killer.role !== 'Mafia')
                    return sendJSON({cmd: 'kl', code: 108, msg: 'Your are not Mafia'});
                if (mbs.length > 0)
                    // MafiaBoss is still alive
                    return sendJSON({cmd: 'kl', code: 104, msg: 'Mafia Boss is still alive'});
                if (mfs.some(puid => {
                    let cp = rooms[roomID].players[puid];
                    return cp.role === 'Mafia' && cp.number < rooms[roomID].players[userID].number;
                }))
                    // There is at least 1 more Mafia with lower number value
                    return sendJSON({cmd: 'kl', code: 109, msg: 'There is at least one mafia which is before you'});
            }

            if (rooms[roomID].nightMode !== 1)
                return sendJSON({cmd: 'kl', code: 1091, msg: 'You can only kill at night on mafia turn'});
            if (rooms[roomID].nightActionPerformed)
                return sendJSON({cmd: 'kl', code: 1092, msg: 'You have already made an assassination this night'});
            killed.status = 'killed';
            sendJSON({cmd: 'kl', code: 100});
            rooms[roomID].nightActionPerformed = true;
            els(roomID, userID, 67);
            return;
        } else if ('cs' === cmd) {
            // Change roles of players requested
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'cs', code: 111, msg: 'You are not the host of room'});
            if (!msg.hasOwnProperty('data'))
                return sendJSON({cmd: 'cs', code: 112, msg: 'Data not specified'});
            msg.data.forEach(function(p) {
                rooms[roomID].players[p.uid].status = p.status;
            });
            sendJSON({cmd: 'cs', code: 110});
            els(roomID, userID, 68);
            return;
        } else if ('vt' === cmd) {
            // Player requested to kill player
            if (!(userID in rooms[roomID].players)) {
                return sendJSON({cmd: 'vt', code: 125, msg: 'You are not in the room'});
            }
            let voter = rooms[roomID].players[userID];
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'vt', code: 121, msg: 'You are not the host of room'});
            if (!msg.hasOwnProperty('puid'))
                return sendJSON({cmd: 'vt', code: 122, msg: 'puid field not specified'});
            let voted = rooms[roomID].players[msg.puid];
            if (voted.team !== 'player')
                return sendJSON({cmd: 'vt', code: 123, msg: 'Player you r killing is not playing ATM.'});
            if (voted.status !== 'playing')
                return sendJSON({cmd: 'vt', code: 124, msg: 'Player you r killing has already been killed or voted.'});
            voted.status = 'voted';
            sendJSON({cmd: 'vt', code: 120});
            els(roomID, userID, 69);
            return;
        } else if ('lr' === cmd) {
            // Host requested to lock room
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'lr', code: 131, msg: 'You are not the host of room'});
            if (!msg.hasOwnProperty('state'))
                return sendJSON({cmd: 'lr', code: 132, msg: 'State not specified'});
            rooms[roomID].locked = msg.state;
            sendJSON({cmd: 'lr', code: 130});
            // els(roomID, userID, 602);
            return;
        } else if ('lg' === cmd) {
            // Host requested to lock game
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'lg', code: 141, msg: 'You are not the host of room'});
            if (!msg.hasOwnProperty('state'))
                return sendJSON({cmd: 'lg', code: 142, msg: 'State not specified'});
            rooms[roomID].playing = msg.state;
            sendJSON({cmd: 'lg', code: 140});
            // els(roomID, userID, 603);
            elg(roomID, null);
            return;
        } else if ('tn' === cmd) {
            // Host requested to toggle night mode: mafia/boss/comissar
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'tn', code: 161, msg: 'You are not the host of room'});
            if (!msg.hasOwnProperty('state'))
                return sendJSON({cmd: 'tn', code: 162, msg: 'State not specified'});
            rooms[roomID].nightMode = msg.state;
            rooms[roomID].nightActionPerformed = false;
            sendJSON({cmd: 'tn', code: 160});
            // els(roomID, userID, 603);
            etn(roomID, null);
            return;
        } else if ('bc' === cmd) {
            // Player made a 'boss check' request
            if (!(userID in rooms[roomID].players))
                return sendJSON({cmd: 'bc', code: 181, msg: 'You are not in the room'});
            if (rooms[roomID].nightMode !== 2)
                return sendJSON({cmd: 'bc', code: 186, msg: 'You can only check at night on mafia boss turn'});
            if (rooms[roomID].players[userID].role !== 'MafiaBoss')
                return sendJSON({cmd: 'bc', code: 185, msg: 'You are not the MafiaBoss'});
            if (rooms[roomID].players[userID].status !== 'playing')
                return sendJSON({cmd: 'bc', code: 187, msg: 'You have already been killed.'});
            if (!msg.hasOwnProperty('puid'))
                return sendJSON({cmd: 'bc', code: 182, msg: 'puid field not specified'});
            let pl = rooms[roomID].players[msg.puid];
            if (pl.team !== 'player')
                return sendJSON({cmd: 'bc', code: 183, msg: 'Player you r checking is not playing ATM.'});
            if (rooms[roomID].nightActionPerformed)
                return sendJSON({cmd: 'bc', code: 184, msg: 'You have already made your check this night'});
            sendJSON({cmd: 'bc', code: 180, role: pl.role === 'Sheriff'});
            rooms[roomID].nightActionPerformed = true;
            return;
        } else if ('sc' === cmd) {
            // Player made a 'sheriff check' request
            if (!(userID in rooms[roomID].players))
                return sendJSON({cmd: 'sc', code: 191, msg: 'You are not in the room'});
            if (rooms[roomID].nightMode !== 3)
                return sendJSON({cmd: 'sc', code: 196, msg: 'You can only check at night on sheriff turn'});
            if (rooms[roomID].players[userID].role !== 'Sheriff')
                return sendJSON({cmd: 'sc', code: 195, msg: 'You are not the Sheriff'});
            if (rooms[roomID].players[userID].status !== 'playing')
                return sendJSON({cmd: 'sc', code: 197, msg: 'You have already been killed.'});
            if (!msg.hasOwnProperty('puid'))
                return sendJSON({cmd: 'sc', code: 192, msg: 'puid field not specified'});
            let pl = rooms[roomID].players[msg.puid];
            if (pl.team !== 'player')
                return sendJSON({cmd: 'sc', code: 193, msg: 'Player you r checking is not playing ATM.'});
            if (rooms[roomID].nightActionPerformed)
                return sendJSON({cmd: 'sc', code: 194, msg: 'You have already made your check this night'});
            sendJSON({cmd: 'sc', code: 190, role: ['MafiaBoss', 'Mafia'].includes(pl.role)});
            rooms[roomID].nightActionPerformed = true;
            return;
        } else if ('dl' === cmd) {
            // Player requested to kill player
            if (!(userID in rooms[roomID].players))
                return sendJSON({cmd: 'dl', code: 201, msg: 'You are not in the room'});
            let voter = rooms[roomID].players[userID];
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'dl', code: 202, msg: 'You are not the host of room'});
            if (!msg.hasOwnProperty('puid'))
                return sendJSON({cmd: 'dl', code: 203, msg: 'puid field not specified'});
            if (rooms[roomID].host === msg.puid)
                rooms[roomID].locked = false;
            sendJSON({cmd: 'dl', code: 204, msg: 'You have been kicked from this room!'}, users[msg.puid].ws);
            users[msg.puid].ws.close(4002, 'You have been kicked from this room!');
            delete users[msg.puid];
            delete rooms[roomID].players[msg.puid];
            sendJSON({cmd: 'dl', code: 200});
            els(roomID, userID, 604);
            return;
        }
        return;
    });
    ws.on('close', function(code, reason) {
        if (connectionID in rooms[roomID].players) {
            rooms[roomID].players[connectionID].dc = true;
            els(null, connectionID, 601);
        }
    });
    function els(roomID, exceptUID, code) {
        // Codes:
        // 62 - user joined
        // 63 - name changed
        // 64 - team changed
        // 65 - numbers changed
        // 66 - roles changed
        // 67 - player killed
        // 68 - statuses changed (by host)
        // 69 - player got voted
        // 601 - user disconnected
        // 602 - room locked/unlocked
        // 603 - game locked/unlocked
        // 604 - player kicked

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
    function elg(roomID, exceptUID) {
        // Codes
        // 151 - game lock state changed
        exceptUID = exceptUID ? exceptUID : null;
        let playing = rooms[roomID].playing;
        Object.keys(rooms[roomID].players).forEach(function(uid) {
            if (uid !== exceptUID)
                sendJSON({cmd: 'elg', code: 151, state: playing}, users[uid].ws);
        });
        return;
    }
    function etn(roomID, exceptUID) {
        // Codes
        // 171 - nightMode state changed
        exceptUID = exceptUID ? exceptUID : null;
        let nightMode = rooms[roomID].nightMode;
        Object.keys(rooms[roomID].players).forEach(function(uid) {
            if (uid !== exceptUID)
                sendJSON({cmd: 'elg', code: 171, state: nightMode}, users[uid].ws);
        });
        return;
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
        if (DEBUG) console.log('[dbg] >> ' + JSON.stringify(json));
        wsock.send(JSON.stringify(json));
    }

    function Room(rid, players, host, locked, playing) {
        if (!rid) console.warn('[Room] Invalid roomID! Something goes wrong!');
        this.roomID = rid;
        this.players = players ? players : {};
        this.host = host ? host : null;
        this.locked = locked ? locked : false;
        this.playing = playing ? playing : false;
        this.nightMode = 0;
        this.nightActionPerformed = false;  // Flag not to allow to spam checks and kills
    }
    function User(uid, ws, name) {
        if (!uid) console.warn('[User] Invalid userID! Something goes wrong!');
        this.uid = uid;
        this.ws = ws ? ws : null;
        this.name = name ? name.toString() : '';
    }
    function Player(uid, team, number, role, status) {
        if (!uid) console.warn('[Player] Invalid userID! Something goes wrong!');
        this.uid = uid ? uid : null;
        this.team = team ? team : 'spec';
        this.name = uid in users ? users[uid].name : '';
        this.role = role ? role : null;
        this.number = number ? number : -1;
        this.status = status ? status : 'playing';
        this.dc = false;
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
websocket.listen();