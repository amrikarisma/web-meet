require('dotenv').config();
const { Socket } = require("engine.io");
const express = require("express");
const cors = require('cors');
const fs = require("fs");
const path = require("path");
var app = express();
var options = {
	key: fs.readFileSync(process.env.SSL_KEY_PATH),
	cert: fs.readFileSync(process.env.SSL_CERT_PATH)
};
var server = require('https').createServer(options, app)
var PORT = process.env.NODE_API_PORT || 3000;

server.listen(PORT, function () {
	console.debug(`listening on port ${PORT}`);
})

const io = require('socket.io')(server, {
	allowEIO3: true,
});

var allowedOrigins = [];

allowedOrigins.push(process.env.NODE_API_URL + ':' + process.env.NODE_API_PORT);
allowedOrigins.push(process.env.NODE_API_URL);
allowedOrigins.push(process.env.APP_URL);
app.use(cors({
	origin: function (origin, callback) {
		console.debug('origin:', origin)
		console.debug('allowedOrigins', allowedOrigins)
		// allow requests with no origin
		// (like mobile apps or curl requests)
		if (!origin) return callback(null, true);
		if (allowedOrigins.indexOf(origin) === -1) {
			var msg = 'The CORS policy for this site does not ' + 'allow access from the specified Origin.';
			return callback(new Error(msg), false);
		}
		return callback(null, true);
	}
}));

app.use(express.static(path.join(__dirname, "public")));

let userConnection = [];

io.on("connection", (socket) => {
	socket.on("userconnect", (data) => {
		if (data.meeting_id) {
			var other_users = userConnection.filter((p) => p.meeting_id == data.meeting_id);
			userConnection.push({
				connectionId: socket.id,
				user_id: data.user_id,
				username: data.username,
				avatar: data.avatar,
				meeting_id: data.meeting_id,
				is_organizer: data.is_organizer,
				created_at: data.created_at
			})

			var userCount = userConnection.length;

			other_users.forEach((v) => {
				socket.to(v.connectionId).emit("inform_others_about_me", {
					other_user_id: data.user_id,
					other_user_name: data.username,
					other_user_avatar: data.avatar,
					connId: socket.id,
					userNumber: userCount,
					is_organizer: data.is_organizer,
					created_at: data.created_at
				});
			})
			socket.emit("inform_me_about_other_user", other_users);
		}
	});

	socket.on("SDPProcess", (data) => {
		socket.to(data.to_connId).emit("SDPProcess", {
			message: data.message,
			from_connId: socket.id,
			to_connId: data.to_connId
		})
	})

	socket.on("disconnect", function () {
		var disconnect_user = userConnection.find((p) => p.connectionId == socket.id);
		if (disconnect_user) {
			var meeting_id = disconnect_user.meeting_id;
			userConnection = userConnection.filter((p) => p.connectionId != socket.id);
			var list = userConnection.filter((p) => p.meeting_id == meeting_id);
			list.forEach((v) => {
				var userNumber = userConnection.length;
				socket.to(v.connectionId).emit("inform_other_about_disconnected_user", {
					connId: socket.id,
					userNumber: userNumber
				});
			})
		}
	});
	socket.on("inform_action_to_participant", function (data) {
		var org_user = userConnection.find((p) => p.connectionId == data.from_connId);
		socket.to(data.connId).emit("inform_participant_about_action", {
			from_username: org_user.username,
			action: data.action
		});
	});
	socket.on("inform_action_to_me", function (data) {
		var org = userConnection.filter((p) => p.meeting_id == data.meeting_id).filter((p) => p.is_organizer === true);
		var target_user = userConnection.find((p) => p.connectionId == data.connId);

		org.forEach(v => {
			socket.to(v.connectionId).emit("inform_me_about_action", {
				action: data.action,
				username: target_user.username,
				from_username: data.from_username,
			});
		});
	});
})

// Start API
app.get('/iceserver', async (req, res) => {
	if (process.env.STUN_URL && process.env.TURN_URL) {
		let token = {
			iceServers: [
				{
					"urls": "stun:" + process.env.STUN_URL
				}, {
					"urls": "turn:" + process.env.TURN_URL,
					"username": process.env.TURN_ID,
					"credential": process.env.TURN_AUTH_TOKEN
				}
			]
		};
		res.send(token);
	} else {
		const accountSid = process.env.TWILIO_ACCOUNT_SID;
		const authToken = process.env.TWILIO_AUTH_TOKEN;
		const client = require('twilio')(accountSid, authToken);

		let token = await client.tokens.create();
		res.send(token);
	}
});
module.exports = app;
