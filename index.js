const argv = require('optimist')
    .usage('Usage: $0 --port [num] --wss --pwd [str] --debug --logs --noconsoleoutput')
    .argv;
const crypto = require('crypto');
const random = require('./util');
const path = require('path');
const fs = require('fs');
const winston = require('winston');

let websocket = null;
if (argv.wss) websocket = require('./websocketHTTPS');
else websocket = require('./websocket');
const webSocket = require('ws');

const DEBUG = !!argv.debug;
const NOCONSOLEOUTPUT = !!argv.noconsoleoutput;
const LOGS2FILE = !!argv.logs;
const MOD_PWD = argv.pwd ? argv.pwd : null;
const PORT = argv.port ? parseInt(argv.port) : 6001;
const LOGPORT = 3000;

const FAKE_NIGHT_RESPONSE_DELAY_PARAMS_CHECKS = {mean:10000, std:2.3, min:5000, max:20000};
const FAKE_NIGHT_RESPONSE_DELAY_PARAMS_ASSASSINATION = {mean:8000, std:3, min:5000, max:25000};
const USERID_MAXLENGTH = 16;
const ROOMID_MAXLENGTH = 16;
const BROWSERINSTANCEID_LENGTH = 4;
const LOGSDIR = path.join(__dirname, 'logs');
const TEAMS = ['spec', 'player'];

function getRoomLogger(roomID) {
    let ts = [];
    if (LOGS2FILE) ts.push(new winston.transports.File({ filename: path.join(LOGSDIR, (roomID ? roomID : 'combined')+'.log') }));
    if (!roomID && !NOCONSOLEOUTPUT) ts.push(new winston.transports.Console());
    let format = winston.format.combine(
        winston.format.timestamp(),
        winston.format.simple(),
    );
    if (!roomID)
        format = winston.format.combine(
            winston.format.timestamp(),
            winston.format.json(),
        );
    const logger = winston.createLogger({
        level: DEBUG ? 'verbose' : 'info',
        format: format,
        transports: ts,
    });
    return logger;
}
const logger = getRoomLogger(null);
if (LOGS2FILE) {
    if (!fs.existsSync(LOGSDIR)) {
        fs.mkdirSync(LOGSDIR);
    }
    logger.info('Logging to file is ON. Find logs in ' + LOGSDIR);
} else
    logger.warn('Logging to file is OFF.');
if (!MOD_PWD) logger.warn('Moderation password is not specified. Specify it with \'--pwd PASSWORD\' flag if necessary.');

let rooms = {};
var users = {};

// const wss = new webSocket.Server({ port: 6001 });
const wss = websocket.websocketServer(PORT);
wss.on('listening', function listening() {
    logger.info('############### Server started on port '+PORT+' ###############');
});

wss.on('connection', function connection(ws, rq) {
    let biidAndRID = parseWebsocketProtocol(rq.headers);
    if (!biidAndRID || biidAndRID.length !== 2) {
        if (MOD_PWD && rq.headers.hasOwnProperty('sec-websocket-protocol') && rq.headers['sec-websocket-protocol'] === MOD_PWD) {
            return onModeratorConnected(ws, rq);
        }
        logger.warn('Invalid websocket protocol value or moderation password!');
        ws.close(1002, 'Invalid websocket protocol value. Must consist of roomID and biID!');
        return;
    }
    let biID = biidAndRID[0];
    let roomID = biidAndRID[1];
    if (!validateRoomID(roomID)) {
        ws.close(4003, 'Invalid roomID. Please try another roomID!');
        return;
    }
    let connectionID = getConnectionHash(rq.headers);
    logger.verbose('#' + connectionID + ' connected to room #'+roomID+' with headers:\n' + JSON.stringify(rq.headers));
    if (rooms[roomID])
        rooms[roomID].logger.verbose('['+connectionID+']: connected');
    // Add new connection to user list and terminate previous connection if there was one
    if (!users.hasOwnProperty(connectionID))
        users[connectionID] = new User(connectionID);
    else
        users[connectionID].ws.close(4001, 'Another connection for this user was created!');
    users[connectionID].ws = ws;
    if (!rooms.hasOwnProperty(roomID)) rooms[roomID] = new Room(roomID, {}, connectionID);
    ws.on('message', function incoming(msgRaw) {
        logger.verbose('['+connectionID+'] (rx): ' + msgRaw);
        let msg = null;
        try {
            msg = JSON.parse(msgRaw);
        } catch (e) {
            return logger.warn('Could not parse client request: ' + msgRaw);
        }

        // Server response must contain 'cmd' field
        if (!msg.hasOwnProperty('cmd'))
            return logger.warn('Invalid client request: ' + msgRaw);
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

        if (rooms[roomID])
            rooms[roomID].logger.verbose('['+connectionID+'] >> '+JSON.stringify(msg));
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
            // If number is undefined (numbers are not supposed to be negative) then assign new number
            if (rooms[roomID].players[userID].number === -1) {
                let mx = Math.max.apply(Math, Object.values(rooms[roomID].players).map(p => p.number));
                rooms[roomID].players[userID].number = mx < 0 ? 1 : (mx + 1);
            }

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
            // Change roles of players (and immunity status) requested
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'cr', code: 91, msg: 'You are not the host of room'});
            if (!msg.hasOwnProperty('data'))
                return sendJSON({cmd: 'cr', code: 92, msg: 'Data not specified'});
            msg.data.forEach(function(p) {
                rooms[roomID].players[p.uid].role = p.role;
                rooms[roomID].players[p.uid].immunity = p.immunity;
            });
            rooms[roomID].currentTurn = 0;
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

            if (rooms[roomID].nightMode !== 1)
                return sendJSON({cmd: 'kl', code: 1091, msg: 'You can only kill at night on mafia turn'});
            if (rooms[roomID].nightActionPerformed)
                return sendJSON({cmd: 'kl', code: 1092, msg: 'You have already made an assassination this night'});

            let mbs = Object.keys(rooms[roomID].players).filter(puid => {
                let cp = rooms[roomID].players[puid];
                return cp.role === 'MafiaBoss' && cp.status === 'playing';
            });
            let mfs = Object.keys(rooms[roomID].players).filter(puid => {
                let cp = rooms[roomID].players[puid];
                return cp.role === 'Mafia' && cp.status === 'playing';
            });

            if (killer.role !== 'MafiaBoss') {
                if (killer.role !== 'Mafia')
                    return sendJSON({cmd: 'kl', code: 108, msg: 'Your are not Mafia'});
                if (mbs.length > 0)
                    // MafiaBoss is still alive
                    return sendJSON({cmd: 'kl', code: 104, msg: 'Mafia Boss is still alive'});
                if (mfs.some(puid => {
                    let cp = rooms[roomID].players[puid];
                    // return cp.role === 'Mafia' && cp.number < rooms[roomID].players[userID].number;
                    return cp.number < rooms[roomID].players[userID].number;
                })) {
                    // There is at least 1 more Mafia with lower number value
                    return sendJSON({cmd: 'kl', code: 109, msg: 'There is at least one mafia which is before you'});
                }
            }
            if (rooms[roomID].currentTurn === 1 && killed.immunity)
                return sendJSON({cmd: 'kl', code: 107, msg: 'Player you r killing has immunity for the 1st round.'});

            killed.status = 'killed';
            sendJSON({cmd: 'kl', code: 100});
            rooms[roomID].nightActionPerformed = true;
            els(roomID, userID, 67);
            etf(roomID, userID);
            ews(roomID);
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
            // Player requested to vote against player
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
                return sendJSON({cmd: 'vt', code: 123, msg: 'Player you r voting is not playing ATM.'});
            if (voted.status !== 'playing')
                return sendJSON({cmd: 'vt', code: 124, msg: 'Player you r voting has already been killed or voted.'});
            voted.status = 'voted';
            sendJSON({cmd: 'vt', code: 120});
            els(roomID, userID, 69);
            ews(roomID);
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
            if (msg.state === 1)
                rooms[roomID].currentTurn += 1;
            sendJSON({cmd: 'tn', code: 160});
            // els(roomID, userID, 603);
            etn(roomID, null);
            let pls = Object.values(rooms[roomID].players).filter(p => p.status === 'playing' && p.team === 'player');
            if (rooms[roomID].nightMode === 1) { // Mafias turn
                if (!pls.some(p => p.role === 'MafiaBoss' || p.role === 'Mafia'))
                    imitateNightActionPerformed(roomID);
            } else if (rooms[roomID].nightMode === 2) { // MafiaBoss' turn
                if (!pls.some(p => p.role === 'MafiaBoss'))
                    imitateNightActionPerformed(roomID);
            } else if (rooms[roomID].nightMode === 3) { // Sheriff's turn
                if (!pls.some(p => p.role === 'Sheriff'))
                    imitateNightActionPerformed(roomID);
            }
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
            etf(roomID, userID);
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
            etf(roomID, userID);
            return;
        } else if ('dl' === cmd) {
            // Player requested to kick other player
            if (!(userID in rooms[roomID].players))
                return sendJSON({cmd: 'dl', code: 201, msg: 'You are not in the room'});
            let voter = rooms[roomID].players[userID];
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'dl', code: 202, msg: 'You are not the host of room'});
            if (!msg.hasOwnProperty('puid'))
                return sendJSON({cmd: 'dl', code: 203, msg: 'puid field not specified'});
            if (rooms[roomID].host === msg.puid)
                rooms[roomID].locked = false;
            sendJSON({cmd: 'dl', code: 204, msg: 'You have been kicked from this room!'}, users[msg.puid]);
            users[msg.puid].ws.close(4002, 'You have been kicked from this room!');
            delete users[msg.puid];
            delete rooms[roomID].players[msg.puid];
            sendJSON({cmd: 'dl', code: 200});
            els(roomID, userID, 604);
            return;
        } else if ('gh' === cmd) {
            // Host requested to transfer hostage to other player
            if (!(userID in rooms[roomID].players))
                return sendJSON({cmd: 'gh', code: 211, msg: 'You are not in the room'});
            let voter = rooms[roomID].players[userID];
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'gh', code: 212, msg: 'You are not the host of room'});
            if (!msg.hasOwnProperty('puid'))
                return sendJSON({cmd: 'gh', code: 213, msg: 'puid field not specified'});
            sendJSON({cmd: 'gh', code: 214, msg: 'The host transferred the hostage to you!'}, users[msg.puid]);
            rooms[roomID].host = msg.puid;
            sendJSON({cmd: 'gh', code: 210});
            els(roomID, userID, 605);
            return;
        } else if ('tg' === cmd) {
            // Host requested toggle states (game-, room-Locked, nightMode)
            if (!(userID in rooms[roomID].players))
                return sendJSON({cmd: 'tg', code: 221, msg: 'You are not in the room'});
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'tg', code: 222, msg: 'You are not the host of room'});
            sendJSON({
                cmd: 'tg', code: 220,
                gameLock: rooms[roomID].playing,
                nightMode: rooms[roomID].nightMode,
                roomLock: rooms[roomID].locked
            });
            return;
        } else if ('ws' === cmd) {
            // Host requested to check if game has ended
            if (!(userID in rooms[roomID].players))
                return sendJSON({cmd: 'ws', code: 241, msg: 'You are not in the room'});
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'ws', code: 242, msg: 'You are not the host of room'});
            sendJSON({cmd: 'ws', code: 240, state: gameWinState(roomID)});
            return;
        } else if ('gr' === cmd) {
            // Give role command. Triggers egr event for user given in puid
            if (!(userID in rooms[roomID].players))
                return sendJSON({cmd: 'gr', code: 261, msg: 'You are not in the room'});
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'gr', code: 262, msg: 'You are not the host of room'});
            if (!msg.hasOwnProperty('puid'))
                return sendJSON({cmd: 'gr', code: 263, msg: 'puid field not specified'});
            if (!(msg.puid in rooms[roomID].players))
                return sendJSON({cmd: 'gr', code: 264, msg: 'puid is not found'});
            if (rooms[roomID].players[msg.puid].dc) {
                return sendJSON({cmd: 'gr', code: 265, msg: 'This user is disconnected. No role sent'});
            }
            sendJSON({cmd: 'gr', code: 260});
            egr(roomID, msg.puid);
            return;
        } else if ('rr' === cmd) {
            // Role received command. Triggers err event for the host
            if (!(userID in rooms[roomID].players))
                return sendJSON({cmd: 'rr', code: 281, msg: 'You are not in the room'});
            sendJSON({cmd: 'rr', code: 280});
            erc(roomID, userID);
            return;
        } else if ('hl' === cmd) {
            // Help command. Player asked for help
            if (!(userID in rooms[roomID].players))
                return sendJSON({cmd: 'hl', code: 301, msg: 'You are not in the room'});
            if (rooms[roomID].players[rooms[roomID].host].dc)
                return sendJSON({cmd: 'hl', code: 302, msg: 'Host is disconnected. Request is not proceeded'});
            if (rooms[roomID].players[userID].team !== 'player')
                return sendJSON({cmd: 'hl', code: 303, msg: 'You are not playing ATM.'});
            if (rooms[roomID].players[userID].status !== 'playing')
                return sendJSON({cmd: 'hl', code: 104, msg: 'You have already been killed.'});

            sendJSON({cmd: 'ehq', code: 311, puid: userID}, users[rooms[roomID].host]);
            sendJSON({cmd: 'hl', code: 300});
            return;
        } else if ('hr' === cmd) {
            // Help response. Host responds to player
            if (!(userID in rooms[roomID].players))
                return sendJSON({cmd: 'hr', code: 321, msg: 'You are not in the room'});
            if (rooms[roomID].host !== userID)
                return sendJSON({cmd: 'hr', code: 322, msg: 'You are not the host of the room'});
            if (!msg.hasOwnProperty('data'))
                return sendJSON({cmd: 'hr', code: 323, msg: 'data field not specified'});
            if (!msg.hasOwnProperty('puid'))
                return sendJSON({cmd: 'hr', code: 324, msg: 'puid field not specified'});
            if (!(msg.puid in rooms[roomID].players))
                return sendJSON({cmd: 'hr', code: 325, msg: 'puid is not found'});

            sendJSON({cmd: 'hr', code: 320});
            sendJSON({cmd: 'ehr', code: 331, data: msg.data}, users[msg.puid]);
            return;
        }
        return;
    });
    ws.on('close', function(code, reason) {
        if (roomID in rooms && connectionID in rooms[roomID].players) {
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
        // 605 - host changed

        // Broadcast new list of players, when something changes
        exceptUID = exceptUID ? exceptUID : null;
        code = code ? code : 61;
        // Broadcast only to users of room with roomID, if roomID is specified
        if (roomID) {
            Object.keys(rooms[roomID].players).forEach(function(uid) {
                if (uid !== exceptUID)
                    sendJSON({cmd: 'els', code: code, data: prepareListOfUsers(roomID)}, users[uid]);
            });
            return;
        }
        // Broadcast to every room, where exceptUID participates
        Object.keys(rooms).forEach(function(rid) {
            Object.keys(rooms[rid].players).forEach(function(uid) {
                if (rooms[rid].players.hasOwnProperty(exceptUID) && uid !== exceptUID)
                    sendJSON({cmd: 'els', code: code, data: prepareListOfUsers(rid)}, users[uid]);
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
                sendJSON({cmd: 'elg', code: 151, state: playing}, users[uid]);
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
                sendJSON({cmd: 'elg', code: 171, state: nightMode}, users[uid]);
        });
        return;
    }
    function gameWinState(roomID) {
        let players = rooms[roomID].players;
        let playersAlive = Object.keys(players).filter(uid =>
            players[uid].team === 'player' &&
            players[uid].status === 'playing');
        let black = playersAlive.filter(uid => players[uid].role === 'Mafia' || players[uid].role === 'MafiaBoss');
        let red = playersAlive.filter(uid => players[uid].role === 'Innocent' || players[uid].role === 'Sheriff');
        if (black.length === 0)
            return 'red';
        else if (black.length >= red.length)
            return 'black';
        return 'progress';
    }
    function ews(roomID) {
        // Event win state - sends to host command that game finished
        sendJSON({cmd: 'ews', code: 231, state: gameWinState(roomID)}, users[rooms[roomID].host]);
    }
    function etf(roomID, uid) {
        // Event on night action finished
        sendJSON({cmd: 'etf', code: 251, nightMode: rooms[roomID].nightMode, uid: uid}, users[rooms[roomID].host]);
    }
    function egr(roomID, uid) {
        // Event on give role command. Triggers specified in uid player with his role
        // 271 - server sends a role to you
        if (!uid in rooms[roomID]) return;
        sendJSON({cmd: 'egr', code: 271, role: rooms[roomID].players[uid].role}, users[uid]);
    }
    function erc(roomID, uid) {
        // Event on role received command.
        if (!uid in rooms[roomID]) return;
        sendJSON({cmd: 'erc', code: 291, uid: uid}, users[rooms[roomID].host]);
    }
    function imitateNightActionPerformed(roomID) {
        // Triggers etf() event in some random time from this function call
        const params = rooms[roomID].nightMode === 1 ?
            FAKE_NIGHT_RESPONSE_DELAY_PARAMS_ASSASSINATION :
            FAKE_NIGHT_RESPONSE_DELAY_PARAMS_CHECKS;
        let rnd = null;
        do {
            rnd = random.normal(params.mean, params.std);
        } while (rnd < params.min || rnd > params.max);
        setTimeout(arg => {
            etf(arg, null);
        }, rnd, roomID);
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
    function sendJSON(json, user) {
        wsock = user ? user.ws : ws;
        uid = user ? user.uid : connectionID;
        if (rooms[roomID]) {
            rooms[roomID].logger.verbose('[' + uid + '] << ' + JSON.stringify(json))
        }
        sendDICT(json, wsock, uid);
    }

    function Room(rid, players, host, locked, playing) {
        if (!rid) logger.warn('[Room] Invalid roomID! Something goes wrong!');
        this.roomID = rid;
        this.tsCreated = new Date().getTime();
        this.players = players ? players : {};
        this.host = host ? host : null;
        this.locked = locked ? locked : false;
        this.playing = playing ? playing : false;
        this.nightMode = 0;
        this.nightActionPerformed = false;  // Flag not to allow to spam checks and kills
        this.currentTurn = 0; // Counter for number of mafia's turns (used for immunity)
        this.logger = getRoomLogger(rid);
        this.logger.info('########## Room created ##########');
    }
    Room.prototype.toJSON = function() {
        return {
            roomID: this.roomID,
            tsCreated: this.tsCreated,
            players: this.players,
            host: this.host,
            locked: this.locked,
            playing: this.playing,
            nightMode: this.nightMode,
            nightActionPerformed: this.nightActionPerformed,
            currentTurn: this.currentTurn,
        }
    };
    function User(uid, ws, name) {
        if (!uid) logger.warn('[User] Invalid userID! Something goes wrong!');
        this.uid = uid;
        this.ws = ws ? ws : null;
        this.name = name ? name.toString() : '';
    }
    function Player(uid, team, number, role, status, immunity) {
        if (!uid) logger.warn('[Player] Invalid userID! Something goes wrong!');
        this.uid = uid ? uid : null;
        this.team = team ? team : 'spec';
        this.name = uid in users ? users[uid].name : '';
        this.role = role ? role : null;
        this.immunity = immunity ? immunity : false;
        this.number = number ? number : -1;
        this.status = status ? status : 'playing';
        this.dc = false;
    }
});
function onModeratorConnected(ws, rq) {
    let connID = getConnectionHash(rq.headers);
    logger.info(`Moderator ${connID} connected!`);
    ws.on('message', function incoming(msgRaw) {
        logger.info('(rx): ' + msgRaw);
        let msg = null;
        try {
            msg = JSON.parse(msgRaw);
        } catch (e) {
            return logger.warn('Could not parse client request: ' + msgRaw);
        }
        // Server response must contain 'cmd' field
        if (!msg.hasOwnProperty('cmd'))
            return logger.warn('Invalid client request: ' + msgRaw);
        let cmd = msg.cmd;

        if ('rl' === cmd) {
            // Moderator requested room list
            return sendJSON({cmd: 'rl', code: 10000, rooms: JSON.stringify(rooms)});
        } else if ('gh' === cmd) {
            // Moderator requested to transfer hostage to other player
            if (!msg.hasOwnProperty('rid'))
                return sendJSON({cmd: 'gh', code: 10101, msg: 'rid field not specified'});
            if (!rooms.hasOwnProperty(msg.rid))
                return sendJSON({cmd: 'gh', code: 10102, msg: 'room not found'});
            if (!msg.hasOwnProperty('puid'))
                return sendJSON({cmd: 'gh', code: 10013, msg: 'puid field not specified'});
            if (!users.hasOwnProperty(msg.puid))
                return sendJSON({cmd: 'gh', code: 10014, msg: 'user not found'});
            sendJSON({cmd: 'gh', code: 214, msg: 'The host transferred the hostage to you!'}, users[msg.puid]);
            rooms[msg.rid].host = msg.puid;
            sendJSON({cmd: 'gh', code: 10100});
            return;
        } else if ('dr' === cmd) {
            // Moderator requested to delete room
            if (!msg.hasOwnProperty('rid'))
                return sendJSON({cmd: 'dr', code: 10201, msg: 'rid field not specified'});
            if (!rooms.hasOwnProperty(msg.rid))
                return sendJSON({cmd: 'dr', code: 10202, msg: 'room not found'});
            Object.keys(rooms[msg.rid].players).forEach(uid => {
                if (users.hasOwnProperty(uid)) {
                    let ws = users[uid].ws;
                    if (ws.readyState === webSocket.OPEN || ws.readyState === webSocket.CONNECTING)
                        ws.close(4004, 'Administrator has deleted this room');
                    delete users[uid];
                }
            });
            delete rooms[msg.rid];
            sendJSON({cmd: 'dr', code: 10200});
            return;
        }
    });

    function sendJSON(json, wsock) {
        wsock = wsock ? wsock : ws;
        sendDICT(json, wsock);
    }
}
function getConnectionHash(headers) {
    let postfix = '';
    if (headers.hasOwnProperty('sec-websocket-protocol'))
        postfix = headers['sec-websocket-protocol'];
    return crypto.createHash('md5')
        .update(headers['origin'] + '=>' + headers['user-agent'] + postfix)
        .digest("hex").substring(0, USERID_MAXLENGTH);
}
function parseWebsocketProtocol(headers) {
    if (!headers.hasOwnProperty('sec-websocket-protocol')) return null;
    let protocol = headers['sec-websocket-protocol'];
    if (protocol.length <= BROWSERINSTANCEID_LENGTH) return null;
    return [protocol.substring(0, BROWSERINSTANCEID_LENGTH), protocol.substring(BROWSERINSTANCEID_LENGTH)];
}
function validateRoomID(roomID) {
    return roomID.length > 0
        && roomID.length <= ROOMID_MAXLENGTH
        && /^[a-z0-9]+$/i.test(roomID);
    // return chatID;
}
function validateName(name) {
    return name.length > 0
        && name.length <= USERID_MAXLENGTH
        && /^[\wа-яё0-9\s-.,!?/\\]+$/i.test(name);
    // return name;
}
function sendDICT(dict, wsock, connID) {
    dict['timestamp'] = new Date().getTime();
    logger.verbose((connID ? ('['+connID+'] ') : '')+'(tx): ' + JSON.stringify(dict));
    wsock.send(JSON.stringify(dict));
}


websocket.listen();

// Start logging server
const app = require('express')();
require('winston-logs-display/app.js')(app, logger);
app.listen(LOGPORT, function () {
    logger.log('info', 'Logging server started on port '+LOGPORT);
});