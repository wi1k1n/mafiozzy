# Mafiozzy

A simple toolset for playing board game "Mafia" online.
Consists of server part (NodeJS) and client part (Web-page).

# Documentation

Client communicates with server using Websocket protocol.
Every packet is a JSON object.
Each packet contains mandatory field `cmd` that reflects one of
predefined commands (check below).
Each Server->Client packet contains both `cmd` and `code` fields.
`code` field contains return code.

### Client -> Server

Used placeholders:

* `<userID>` - [string] for each user and browser instance
* `<roomID>` - [string] for each room
* `<returnMsg>` - [string] message describing what does response mean
* `<username>` - [string] displayed name for user

Client -> Server commands (Server responses in sublist):
 
1. `{cmd: 'err', code: 1, msg: <returnMsg>}` - this userID is not registered yet
2. `{cmd: 'id'}` - request server the userID
    * `{cmd: 'id', code: 10, uid: <userID>}` - userID successfully generated and returned
2. `{cmd: 'nm', uid: <userID>, name: <username>}` - send username
    * `{cmd: 'nm', code: 50}` - username successfully set
    * `{cmd: 'nm', code: 51, msg: <returnMsg>}` - `name` field was not found in client's request
    * `{cmd: 'nm', code: 52, msg: <returnMsg>}` - username is invalid
    * `{cmd: 'nm', code: 53, msg: <returnMsg>}` - requested username is already set, no changes were made
3. `{cmd: 'cr', uid: <userID>, rid: <roomID>}` - request room creation
    * `{cmd: 'cr', code: 20}` - room successfully created
    * `{cmd: 'cr', code: 21, msg: <returnMsg>}` - this roomID is already in use
4. `{cmd: 'jn', uid: <userID>, rid: <roomID>}` - request to join the room
    * `{cmd: 'jn', code: 40}` - successfully joined the room
    * `{cmd: 'jn', code: 41, msg: <returnMsg>}` - no room found with this roomID
    * `{cmd: 'jn', code: 42, msg: <returnMsg>}` - this userID is already in this room
    * `{cmd: 'jn', code: 43, msg: <returnMsg>}` - this room is locked
5. `{cmd: 'ls', uid: <userID>, rid: <roomID>}` - request list of users
    * `{cmd: 'ls', code: 30, data: <usersList>}` - successfully joined the room
        * `<usersList>: {players:[<player>], host: <userID>}`
        * `<player>: {uid: <userID>, team: <team>, name: <username>`
        * `<team>: 'spec'|'player'`
    * `{cmd: 'ls', code: 31, msg: <returnMsg>}` - this room is locked
    
Server -> Client events:
1. `<cmd: 'els', code: 61, data: <`