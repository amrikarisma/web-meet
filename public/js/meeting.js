const MyApp = (function () {
	let localVideoPlayer = document.getElementById('localVideoPlayer');
	const meetingWrap = document.getElementById('meeting');

	let audio;
	let isAudioMute = true;
	let serverProcess;
	let my_connection_id;
	let user;
	let meeting_id;
	let is_organizer;
	let participants = [];

	// keep track of some negotiation state to prevent races and errors
	let makingOffer = false;
	let ignoreOffer = false;
	let retryCount = 0;
	const RETRY_LIMIT = 10;

	// Connection
	let iceConfiguration;
	let peers_connection_ids = [];
	let peers_connection = [];
	let remote_vid_stream = [];
	let remote_aud_stream = [];

	var video_states = {
		None: 0,
		Camera: 1,
		ScreenShare: 2,
	}
	var video_st = video_states.None;
	let vstream = null;
	let astream = null;
	let videoCamTrack;
	let rtp_vid_senders = [];
	let rtp_aud_senders = [];
	let audioContext = [];
	let audioPlayer = [];

	let lastRejectCamera;
	let lastRejectAudio;

	// Handle multiple click
	let cameraClicked = false
	let microphoneClicked = false

	async function init(u, mid, organizer) {
		await requestUserMedia();
		addEventOnPreview();
		user = u;
		meeting_id = mid;
		is_organizer = organizer;
		if (meetingWrap) {
			startInitBundle();
		}
	}

	function startInitBundle() {
		$("#meetingContainer").css('display', 'flex');
		requestIceServer();
		eventProcessForSignalingServer();
		user.username = user.admin_name || user.merchant_name || user.subscriber_name || user.staff_full_name || '';

		if (is_organizer) {
			$('.participant-list-me').addClass('organizer');
		}
	}

	async function requestIceServer() {
		const response = await fetch(NODE_API_URL + "/iceserver", {
			method: "GET",
			mode: 'cors',
			headers: {}
		});
		const iceserver = await response.json();
		iceConfiguration = {
			iceServers: iceserver.iceServers
		};
	}

	function initiateManualRollback(connId) {
		closeConnection(connId)
		setConnection(connId)
	}

	async function setConnection(connId) {
		var connection = new RTCPeerConnection(iceConfiguration)
		peers_connection_ids[connId] = connId;
		peers_connection[connId] = connection;

		peers_connection[connId].onnegotiationneeded = async function (event) {
			console.debug("onnegotiationneeded", connId)
			try {
				makingOffer = true;
				var offer = await peers_connection[connId].createOffer();
				console.debug("offer:", offer, connId)
				await peers_connection[connId].setLocalDescription(offer);
				serverProcess(JSON.stringify({
					offer: peers_connection[connId].localDescription,
				}), connId)
			} catch (err) {
				console.error(err)
			} finally {
				makingOffer = false;
			}
		}
		peers_connection[connId].onicecandidate = async function (event) {
			console.debug("onicecandidate: ", connId)
			if (event.candidate) {
				serverProcess(JSON.stringify({ iceCandidate: event.candidate }), connId)
			}
		}

		peers_connection[connId].oniceconnectionstatechange = async (event) => {
			console.debug(`[${new Date().getTime()}] oniceconnectionstatechange: `, peers_connection[connId].iceConnectionState)
			if (peers_connection[connId].iceConnectionState === "failed") {
				/* possibly reconfigure the connection in some way here */
				/* then request ICE restart */
				if (peers_connection[connId].restartIce) {
					peers_connection[connId].restartIce()
				} else {
					peers_connection[connId].onnegotiationneeded({
						iceRestart: true,
					});
				}
			}
		};

		peers_connection[connId].ontrack = ({ track, streams: [stream] }) => {
			console.debug("ontrack")
			track.onunmute = () => {
				const remoteVideoPlayer = document.getElementById("v_" + connId);

				if (!remote_vid_stream[connId]) {
					remote_vid_stream[connId] = new MediaStream();
				}
				if (!remote_aud_stream[connId]) {
					remote_aud_stream[connId] = new MediaStream();
				}
				if (track.kind == "video" && remoteVideoPlayer.srcObject == null) {
					remote_vid_stream[connId].getVideoTracks().forEach((t) => remote_vid_stream[connId].removeTrack(t));
					remote_vid_stream[connId].addTrack(track, stream);
					remoteVideoPlayer.classList.remove('loaded')
					remoteVideoPlayer.srcObject = null;
					remoteVideoPlayer.srcObject = remote_vid_stream[connId];
					remoteVideoPlayer.load();
					remoteVideoPlayer.onloadedmetadata = () => {
						remoteVideoPlayer.classList.add('loaded')
						console.debug('remoteVideoPlayer:', !remoteVideoPlayer.paused)
					};
					console.debug("onunmute: ", track)

				} else if (track.kind == "audio") {
					remote_aud_stream[connId].getAudioTracks().forEach((t) => remote_aud_stream[connId].removeTrack(t));
					remote_aud_stream[connId].addTrack(track, stream);

					if (!audioContext[connId]) {
						audioContext[connId] = new AudioContext();
					}

					if (!audioPlayer[connId]) {
						audioPlayer[connId] = new Audio();
					}

					audioPlayer[connId].srcObject = remote_aud_stream[connId];
					const source = audioContext[connId].createMediaStreamSource(stream)
					source.connect(audioContext[connId].destination)
					audioPlayer[connId].play();
					console.debug('audioContext:', audioContext[connId], connId)

					if (audioContext[connId].state === "suspended") {
						audioContext[connId].resume();
						audioPlayer[connId].play();
						console.debug('audioContext resume:', audioContext[connId], connId)
					}
					console.debug("onunmute: ", track)
				} else {
					console.debug("onunmute: skipped")
				}
			};

			stream.onremovetrack = ({ track }) => {
				console.debug('onremovetrack', track)
				if (track.kind == 'video') {
					var remoteVideoPlayer = document.getElementById("v_" + connId);
					remoteVideoPlayer.srcObject = null;
					remoteVideoPlayer.classList.remove('loaded')
				} else if (track.kind == 'audio') {
					audioPlayer[connId].srcObject = null;
					audioContext[connId] = null;
					audioPlayer[connId] = null;
					console.debug('audioContext:', audioContext[connId], connId)

				}
				track.stop();
			};
		}

		if (video_st == video_states.Camera) {
			if (videoCamTrack) {
				await updateMediaSenders(videoCamTrack, rtp_vid_senders, vstream)
			}
		}
		if (!isAudioMute) {
			if (audio) {
				console.debug('audio sender', 'is running')
				await updateMediaSenders(audio, rtp_aud_senders, astream)
			}
		}

		console.debug("connection: ", connection)
		return connection;
	}

	async function SDPProcess(message, from_connId, to_connId) {
		console.debug('participants: ', participants)
		try {
			message = JSON.parse(message);
			let other = participants.find((p) => p.connId == to_connId);
			let me = participants.find((p) => p.connId == from_connId);
			let polite = other.created_at < me.created_at;
			console.debug(`[${new Date().getTime()}] polite: `, polite)
			if (message.answer || message.offer) {
				console.debug('makingOffer: ', makingOffer)
				const offerCollision = (message.offer ? true : false) && (makingOffer || peers_connection[from_connId].signalingState !== "stable");
				console.debug('offerCollision: ', offerCollision)
				ignoreOffer = !polite && offerCollision;
				console.debug('ignoreOffer: ', ignoreOffer)
				if (ignoreOffer) {
					return;
				}

				await peers_connection[from_connId].setRemoteDescription(new RTCSessionDescription(message.answer || message.offer))

				if (message.offer) {
					var answer = await peers_connection[from_connId].createAnswer();
					console.debug("answer:", await answer)

					await peers_connection[from_connId].setLocalDescription(answer);
					serverProcess(JSON.stringify({
						answer: answer,
					}), from_connId)
				}
			} else if (message.iceCandidate) {
				try {
					await peers_connection[from_connId].addIceCandidate(message.iceCandidate);
				} catch (err) {
					if (!ignoreOffer) {
						throw err;
					}
				}
			}
		} catch (err) {
			if (retryCount <= RETRY_LIMIT) {
				console.debug('retrying for negotiation...');
				initiateManualRollback(peers_connection[from_connId])
				retryCount++
			} else {
				console.error(`Negotiation failed after ${retryCount} retries`)
			}
		}
	}

	async function closeConnection(connId) {
		peers_connection_ids[connId] = null;
		if (peers_connection[connId]) {
			peers_connection[connId].close();
			peers_connection[connId] = null;
		}
		if (remote_aud_stream[connId]) {
			remote_aud_stream[connId].getTracks().forEach((t) => {
				if (t.stop) {
					t.stop();
				}
			});
			remote_aud_stream[connId] = null;
		}
		if (remote_vid_stream[connId]) {
			remote_vid_stream[connId].getTracks().forEach((t) => {
				if (t.stop) {
					t.stop();
				}
			});
			remote_vid_stream[connId] = null;
		}
	}

	async function closeAllConnection() {
		peers_connection_ids.forEach(connId => {
			closeConnection(connId);
		});
	}

	function connectionStatus(connection) {
		if (connection && (connection.connectionState == "new" || connection.connectionState == "connecting" || connection.connectionState == "connected")) {
			return true;
		} else {
			return false;
		}
	}

	function removeMediaSenders(rtp_senders) {
		for (const con_id in peers_connection_ids) {
			if (rtp_senders[con_id] && connectionStatus(peers_connection[con_id])) {
				peers_connection[con_id].removeTrack(rtp_senders[con_id]);
			}
		}
	}

	async function updateMediaSenders(track, rtp_senders, vstream) {
		for (const con_id in peers_connection_ids) {
			if (connectionStatus(peers_connection[con_id])) {
				if (rtp_senders[con_id] && rtp_senders[con_id].track) {
					rtp_senders[con_id].replaceTrack(track, vstream);
				} else {
					rtp_senders[con_id] = peers_connection[con_id].addTrack(track, vstream);
				}
			}
		}
	}

	async function removeVideoStream(rtp_vid_senders) {
		if (videoCamTrack) {
			videoCamTrack.stop();
			videoCamTrack = null;
			removeMediaSenders(rtp_vid_senders);
		}
		vstream = null;
		localVideoPlayer.srcObject = null;
		localVideoPlayer.classList.remove('loaded');
	}

	async function videoProcess(newVideoState) {
		video_st = newVideoState;
		console.debug('videoProcess: ', newVideoState)
		if (newVideoState == video_states.None) {
			$('.camera').addClass('enable');
			localVideoPlayer.srcObject = null;
			localVideoPlayer.classList.remove('loaded');
		}
		if (newVideoState == video_states.Camera) {
			$('.camera').removeClass('enable');
			try {
				vstream = await navigator.mediaDevices.getUserMedia({
					video: {
						width: 640,
						height: 480,
						facingMode: 'user'
					},
					audio: false
				})
				if (vstream && vstream.getVideoTracks().length > 0) {
					videoCamTrack = vstream.getVideoTracks()[0];
					if (videoCamTrack) {
						localVideoPlayer.srcObject = new MediaStream([videoCamTrack]);
						localVideoPlayer.classList.add('loaded');
					}
				}
			} catch (e) {
				console.debug(e);
			}
		}

		if (lastRejectCamera) lastRejectCamera();
		Promise.race([
			new Promise(res => setTimeout(res, 800, newVideoState)),
			new Promise((_, rej) => {
				lastRejectCamera = rej;
			})
		]).then(async (resp) => {
			console.log('API response: ', resp, newVideoState);
			if (newVideoState == video_states.None) {
				await removeVideoStream(rtp_vid_senders);
			}
			if (newVideoState == video_states.Camera) {
				if (videoCamTrack) {
					await updateMediaSenders(videoCamTrack, rtp_vid_senders, vstream)
				}
			}
		}).catch(() => {
			console.log('Quick click: previous ongoing API call will be ignored');
		});
	}

	async function loadAudio() {
		try {
			astream = await navigator.mediaDevices.getUserMedia({
				video: false,
				audio: true
			});

			audio = astream.getAudioTracks()[0];
			audio.enabled = true;
		} catch (e) {
			console.debug(e);
		}
	}

	async function audioToggle() {
		if (!audio) {
			await loadAudio();
		}

		if (!audio) {
			alert("Audio permission has not grandted");
			return;
		}
		console.debug('audioToggle');
		if (isAudioMute) {
			audio.enabled = true;
			$('.microphone').removeClass('enable');
		} else {
			audio.stop();
			audio = null;
			$('.microphone').removeClass('enable').addClass('enable');
		}

		if (lastRejectAudio) lastRejectAudio();
		Promise.race([
			new Promise(res => setTimeout(res, 800, isAudioMute)),
			new Promise((_, rej) => {
				lastRejectAudio = rej;
			})
		]).then(async (resp) => {
			console.log('API response: ', resp, isAudioMute);
			if (isAudioMute) {
				await updateMediaSenders(audio, rtp_aud_senders, astream);
			} else {
				removeMediaSenders(rtp_aud_senders);
			}
		}).catch(() => {
			console.log('Quick click: previous ongoing API call will be ignored');
		});

		isAudioMute = !isAudioMute;
	}

	async function cameraToggle() {
		if (video_st == video_states.Camera) {
			await videoProcess(video_states.None);
		} else {
			await videoProcess(video_states.Camera);
		}
	}

	function toggleUserList() {
		$('.user-list').toggle();
	}

	function openMeeting() {
		$.ajax({
			url: meetingUrl,
			type: 'GET',
			data: { "ajax": "1" }
		}).then(
			result => {
				document.open();
				document.write(result);
				document.close();
				$(document).ready(function () {
					history.pushState({}, "", meetingUrl.replace('/in', ''));
					setTimeout(() => {
						readyInMeetingRoom();
					}, 1000);
				});
			}
		);
	}

	function endMeeting() {
		location.href = meetingFinishUrl;
	}

	function readyInMeetingRoom() {
		addEventOnMeeting();
		startInitBundle();
	}

	function eventProcessForSignalingServer() {
		socket = io(NODE_API_URL, { transports: ['websocket'] });

		var SDP_function = function (data, to_connId) {
			socket.emit("SDPProcess", {
				message: data,
				to_connId: to_connId,
			})
		}

		socket.on("connect", () => {
			console.debug("socket connected to client side");
			serverProcess = SDP_function;
			my_connection_id = socket.id;
			current_time = new Date().getTime();

			if (user && meeting_id) {
				socket.emit("userconnect", {
					user_id: user.id,
					username: user.username,
					avatar: user.image_file_url,
					meeting_id: meeting_id,
					is_organizer: is_organizer,
					created_at: current_time
				})
				participants.push({
					connId: my_connection_id,
					name: user.username,
					is_organizer: is_organizer,
					created_at: current_time,
				})
			}
		});
		socket.on("disconnect", () => {
			console.debug("socket disconnected to client side");
			$(".userbox").not("#me").not("#otherTemplate").remove();
			$("*[id^='participant_']").remove();
			participants = [];
			closeAllConnection();
		});

		socket.on("inform_other_about_disconnected_user", (data) => {
			$("#" + data.connId).remove();
			$("#participant_" + data.connId).remove();
			participants = participants.filter((p) => p.connId != data.connId);
			closeConnection(data.connId);
		});

		socket.on("inform_others_about_me", async function (data) {
			console.debug('inform_others_about_me: ', data)
			addUser(data.other_user_name, data.is_organizer, data.other_user_avatar, data.created_at, data.connId);
			setConnection(data.connId);
		});

		socket.on("inform_me_about_other_user", async function (other_users) {
			console.debug('inform_me_about_other_user: ', other_users)
			if (other_users) {
				for (let i = 0; i < other_users.length; i++) {
					addUser(other_users[i].username, other_users[i].is_organizer, other_users[i].avatar, other_users[i].created_at, other_users[i].connectionId);
					setConnection(other_users[i].connectionId);
				}
			}
		});

		socket.on("SDPProcess", async function (data) {
			console.debug('SDPProcessClient')
			await SDPProcess(data.message, data.from_connId, data.to_connId);
		});

		socket.on("inform_participant_about_action", async function (data) {
			socket.emit("inform_action_to_me", {
				meeting_id: meeting_id,
				from_username: data.from_username,
				connId: my_connection_id,
				action: data.action,
			});
			switch (data.action) {
				case 'exit':
					closeAllConnection();
					alert('退出になりました。')
					window.location.replace(meetingFinishUrl);
					break;
				case 'mic':
					if (!isAudioMute) {
						await audioToggle();
					}
					break;
			}
		});
		socket.on("inform_me_about_action", async function (data) {
			if (data.action == 'mic') {
				alert(`${data.username}さんは${data.from_username}さんによってミュートになりました。`);
			} else {
				alert(`${data.username}さんは${data.from_username}さんによって退出となりました。`);
			}
		});
	}

	function addUser(other_user_name, other_is_organizer, other_user_avatar, created_at, connId) {
		participants.push({
			connId: connId,
			name: other_user_name,
			is_organizer: other_is_organizer,
			created_at: created_at,
		})
		$('.participant-list .participant-mic').off('click');
		$('.participant-list .participant-exit').off('click');
		var newDivId = $("#otherTemplate").clone();
		newDivId = newDivId.attr("id", connId).addClass("other");
		newDivId.find("h2").text(other_user_name);
		newDivId.find("video").attr("id", "v_" + connId);
		newDivId.find("video").attr("poster", other_user_avatar);
		newDivId.find("audio").attr("id", "a_" + connId);
		newDivId.show();
		$("#divUsers").append(newDivId);
		$(".participant-list > ul").append(`<li id="participant_${connId}" class="${other_is_organizer ? 'organizer' : ''}">
							<img src="${other_user_avatar}">
							<div class="user-info">
								<span class="user-name">${other_user_name}</span>
								<span class="user-role">会議の主催者</span>
							</div>
							${is_organizer ? '<div class="action"><span><i class="fa fa-ellipsis-h"></i></span><ul><li class="participant-mic">ミュート</li><li class="participant-exit">退出</li></ul></div>' : ''}
						</li>`)

		if (is_organizer) {
			$('.participant-list .participant-mic').on('click', function () {
				let participantId = $(this).closest('.action').closest('li').attr('id').toString().replace('participant_', '')
				console.debug('start mute:', participantId);
				socket.emit("inform_action_to_participant", {
					connId: participantId,
					from_connId: my_connection_id,
					action: 'mic'
				});
			});
			$('.participant-list .participant-exit').on('click', function () {
				let participantId = $(this).closest('.action').closest('li').attr('id').toString().replace('participant_', '')
				console.debug('start exit:', participantId);
				socket.emit("inform_action_to_participant", {
					connId: participantId,
					from_connId: my_connection_id,
					action: 'exit'
				});
			});
		}
	}

	async function requestUserMedia() {
		// Just to get permission on first load
		await navigator.mediaDevices.getUserMedia({
			video: true,
			audio: true
		}).then(async (stream) => {
			stream.getTracks().forEach((t) => stream.removeTrack(t));
		})
			.catch((err) => {
				/* handle the error */
				console.debug(err)
			});

		if (!navigator.userActivation) {
			navigator.userActivation = { hasBeenActive: false };
			let pageActivationClickHandler = (e) => {
				if (e.isTrusted) {
					navigator.userActivation.hasBeenActive = true;
					window.removeEventListener("click", pageActivationClickHandler);
				}
			}
			window.addEventListener("click", pageActivationClickHandler);
		}
	}

	function addEventOnPreview() {
		$('.microphone').on('click', async function (e) {
			console.debug('microphone: ', 'clicked')

			if (microphoneClicked) {
				return;
			}
			microphoneClicked = true;
			await audioToggle();
			setTimeout(() => {
				microphoneClicked = false;
			}, 100);
		});

		$('.camera').on('click', async function (e) {
			console.debug('camera: ', 'clicked')
			if (cameraClicked) {
				return;
			}
			cameraClicked = true;
			await cameraToggle();
			setTimeout(() => {
				cameraClicked = false;
			}, 100);
		});
		$('#openMeeting').on('click', function (e) {
			openMeeting();
		});
	}

	function addEventOnMeeting() {
		localVideoPlayer = document.getElementById('localVideoPlayer');
		console.debug('userActivation: ', navigator.userActivation);

		if (videoCamTrack) {
			localVideoPlayer.srcObject = new MediaStream([videoCamTrack]);
			localVideoPlayer.classList.add('loaded');
			$('.camera').removeClass('enable')
		}

		if (!isAudioMute) {
			$('.microphone').removeClass('enable');
		}

		$('.microphone').off();
		$('.camera').off();
		addEventOnPreview();
		$('.user-list-btn').on('click', function (e) {
			toggleUserList();
		});

		$('.add-user', '.search-user').on('click', function (e) {
			openUserSearc();
		});

		$('#endMeetingBtn').on('click', function (e) {
			endMeeting();
		});
	}

	return {
		_init: function (u, mid, o = false) {
			init(u, mid, o);
		},
	};
})();