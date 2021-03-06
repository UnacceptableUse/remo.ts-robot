const config = require('config');
const socketio = require('socket.io-client');
const child_process = require('child_process');
const request = require('request');
const kill = require('tree-kill');
const os = require('os');

var videoType = config.get("VideoType");
var audioType = config.get("AudioType");
var imagePath = "/home/pi/deirdre/images/lrtestcard.png";
var audioPath = "/home/pi/deirdre/soundfx/lemonparty.mp3";
var statusText = null;
var streamPath = config.get("StreamURL");
var appWs;
var videoProcess;
var audioProcess;
var recentVideoRestarts = 0;
var videoError = "";
var xRes = config.get("Resolution")[0];
var yRes = config.get("Resolution")[1];
var micEnabled = config.get("MicrophoneDevice") > -1;

function getVideoPort(){
	return getJSONField(`https://${config.get("Host")}/get_video_port/${config.get("CameraID")}`, "mpeg_stream_port"); 
}

function getAudioPort(){
	return getJSONField(`https://${config.get("Host")}/get_audio_port/${config.get("CameraID")}`, "audio_stream_port");
}

function getWebsocketRelayHost(){
	return getJSONField(`https://${config.get("Host")}/get_websocket_relay_host/${config.get("CameraID")}`);
}

function getOnlineRobotSettings(){
	return getJSONField(`https://${config.get("Host")}/api/v1/robots/${config.get("RobotID")}`);
}

function getChatServer(){
	return getJSONField(`https://${config.get("Host")}/get_chat_host_port/${config.get("RobotID")}`);
}


function setOutputSettings(){
	if(config.get("UseRaspicam")){
		console.log("Using Raspicam");
		child_process.exec("sudo modprobe bcm2835-v4l2");
	}

	child_process.exec(`amixer -c ${config.get("MicrophoneDevice")} cset numid=3 ${config.get("MicrophoneSensitivity")}%`);

	const cameraSettings = config.get("CameraSettings");
	for(var setting in cameraSettings){
		console.log(`Setting V4L2 control: ${setting}=${cameraSettings[setting]}`);
		child_process.exec(`v4l2-ctl -c ${setting}=${cameraSettings[setting]}`);
	}
}

async function setRobotSettings(){
	const robotSettings = await getOnlineRobotSettings();
	console.log(`Robot identified as ${robotSettings.robot_name}`);
	if(robotSettings.mic_enabled === false){
		micEnabled = false;
	}

	if(robotSettings.xres){
		xRes = robotSettings.xres;
	}

	if(robotSettings.yRes){
		yRes = robotSettings.yres;
	}
}

function getJSONField(url, field){
	return new Promise(function(fulfill, reject){
		request(url, function(err, req, body){
			if(err){
				reject(err);
			}else{
				try{
					const data = JSON.parse(body);
					if(!field){
						fulfill(data);
					}else if(data[field]){
						fulfill(data[field]);
					}else{
						throw new Error("JSON Response did not contain "+field);
					}
				}catch(e){
					console.log(body);
					reject(e);
				}
			}
		});
	});
}

async function handleChat(){
	var serverInfo = await getChatServer();
	var socket = socketio(`http://${serverInfo.host}:${serverInfo.port}`);

	socket.on("connect", function(){
		console.log("Connected to chat websocket");
		socket.emit("identify_robot_id", config.get("RobotID"));
	});

	socket.on("chat_message_with_name", function(data){
		var username = data.name;
		var messageRaw = data.message;
		var messageExtracted = messageRaw.split("] ")[1];
		console.log(messageExtracted);
		if(data.name ===  config.get("AdminUser") && messageExtracted.startsWith(".")){
			console.log("Got command");
			const args = messageExtracted.toLowerCase().split(" ");
			if(args[0] === ".setvideo"){
				changeVideoType(args[1]);
			}else if(args[0] === ".setimage"){
				imagePath = config.get("Images")[args[1]];
				if(videoType === "image"){
					startVideo();
				}
			}else if(args[0] === ".setstream"){
				streamPath = args[1];
				if(videoType === "stream"){
					startVideo();
				}
			}else if(args[0] === ".restartnode"){
				process.exit(1);
			}else if(args[0] === ".restartvideo"){
				kill(videoProcess.pid)();
			}else if(args[0] === ".setstatus"){
				statusText = messageExtracted.substring(args[0].length+1);
				startVideo();
			}else if(args[0] === ".clearstatus"){
				statusText = null;
				startVideo();
			}else if(args[0] === ".setaudio"){
				changeAudioType(args[1]);
			}else if(args[0] === ".tdon"){
				imagePath = "/home/pi/deirdre/images/lrtestcard.png";
				audioPath = "/home/pi/deirdre/soundfx/lemonparty.mp3";
				changeAudioType("mp3");
				changeVideoType("image");
			}else if(args[0] === ".tdoff"){
				changeAudioType("microphone");
				changeVideoType("camera");
			}else if(args[0] === ".endon"){
				imagePath = "/home/pi/deirdre/images/deirdre-endcard.png";
				audioPath = "/home/pi/deirdre/soundfx/goodbye.mp3";
				changeAudioType("mp3");
				changeVideoType("image");
			}else if(args[0] === ".shutdown"){
				child_process.exec("sudo shutdown now");
			}
		}
	});
}

function connectToAppServer(){
	console.log("Connecting to app websocket...");
	appWs = socketio(`http://${config.get("Host")}:8022`);


	appWs.on("connect", function(){
		console.log("Connected to app websocket");
	});

	appWs.on("command_to_robot", function(data){
		console.log(arguments);
	});

	appWs.emit('identify_robot_id', config.get("RobotID"));

	setInterval(function(){
		appWs.emit('send_video_status', {
		    	'send_video_process_exists': true, 
		    	'ffmpeg_process_exists': true, 
		    	'camera_id':config.get("CameraID")
	    });
	}, 60000);


	setInterval(function(){
		appWs.emit('identify_robot_id', config.get("RobotID"));
	}, 60000);
}

function createStaticText(text, x, y, size, color, boxcolor, boxborder){
	var output = 'drawtext="';
	output += `text='${text}':`;
	output += `fontcolor=${color || "white"}:`;
	output += `fontsize=${size || 24}:`;
	output += "box=1:";
	output += `boxcolor=${boxcolor || "black@0.5"}:`;
	output += `boxborderw=${boxcolor || "5"}:`;
	output += `x=${x}:`;
	output += `y=${y}`;
	output += '"';
	return output;

}

function createDynamicText(file, x, y, size, color, boxcolor, boxborder){
	var output = 'drawtext="';
	output += `textfile='${file}':`;
	output += `reload=1:`;
    output += `fontfile=/home/pi/letsrobot-node/letsrobot/fonts/VeraMono.ttf:`;
	output += `fontcolor=${color || "white"}:`;
	output += `fontsize=${size || 24}:`;
	output += "box=0:";
	// output += `boxcolor=${boxcolor || "black@0.5"}:`;
	// output += `boxborderw=${boxcolor || "5"}:`;
	output += `x=${x}:`;
	output += `y=${y}`;
	output += '"';
	return output;
}

function createVideoFilters(){
	var output = "";

	if(statusText){
		//output+=createStaticText(statusText, 5, 5);
	}

	 //output += createDynamicText("/home/pi/osdwarning", "(main_w/2-text_w/2)","h/2",25, "red");
	
	if(config.get("FlipVideo")){
		output += ",";
		output += "transpose=2,transpose=2";
	}

	if(output === "")return null;
	return ["-vf", output];
}


async function createCameraArgs(){
	const relayHost = await getWebsocketRelayHost();
	const videoPort = await getVideoPort();
	const videoFilters = createVideoFilters();
	var videoOptions = ["-f", "v4l2"];
	videoOptions.push("-framerate", config.get("Framerate")); 	//Input Framerate
	videoOptions.push("-video_size", `${xRes}x${yRes}`); 		//Input Resolution
	videoOptions.push("-r", config.get("Framerate")); 			//Input Framerate
	videoOptions.push("-i", config.get("VideoDevice")); 		//Input Device
	if(videoFilters)
		videoOptions.push(videoFilters[0], videoFilters[1]);
	videoOptions.push("-f", "mpegts"); 							//Output Format
	videoOptions.push("-codec:v", "mpeg1video"); 				//Output Codec
	videoOptions.push("-b:v", config.get("VideoBitrate")); 		//Bitrate
	videoOptions.push("-bf", "0"); 								//B-Frames
	videoOptions.push("-muxdelay", "0.001"); 					//Maximum Demux-decode Delay.
	videoOptions.push(`http://${config.get("Host")}/transmit?name=${config.get("Channel")}/${xRes}/${yRes}/ `);
	return videoOptions;
}

async function createStreamArgs(){
	const relayHost = await getWebsocketRelayHost();
	const videoPort = await getVideoPort();
	const videoFilters = createVideoFilters();

	var videoOptions = [];
	videoOptions.push("-r", config.get("Framerate")); 			//Input Framerate
	videoOptions.push("-buffer_size", "500000");
	videoOptions.push("-i", streamPath); 						//Input Device
	if(videoFilters)
		videoOptions.push(videoFilters[0], videoFilters[1]);
	videoOptions.push("-f", "mpegts"); 							//Output Format
	videoOptions.push("-codec:v", "mpeg1video"); 				//Output Codec
	videoOptions.push("-b:v", config.get("VideoBitrate")); 		//Bitrate
	videoOptions.push("-bf", "0"); 								//B-Frames
	videoOptions.push("-muxdelay", "0.001"); 					//Maximum Demux-decode Delay.
	videoOptions.push(`http://${relayHost.host}:${videoPort}/${config.get("StreamKey")}/${xRes}/${yRes}/ `); 
	return videoOptions;
}

async function createImageArgs(){
	const relayHost = await getWebsocketRelayHost();
	const videoPort = await getVideoPort();
	const videoFilters = createVideoFilters();
	var videoOptions = ["-loop", "1"];
	videoOptions.push("-i", imagePath); 						//Input Device
	if(videoFilters)
		videoOptions.push(videoFilters[0], videoFilters[1]);
	videoOptions.push("-f", "mpegts"); 							//Output Format
	videoOptions.push("-codec:v", "mpeg1video"); 				//Output Codec
	videoOptions.push("-b:v", config.get("VideoBitrate")); 		//Bitrate
	videoOptions.push("-bf", "0"); 								//B-Frames
	videoOptions.push("-muxdelay", "0.001"); 					//Maximum Demux-decode Delay.
	videoOptions.push(`http://${relayHost.host}:${videoPort}/${config.get("StreamKey")}/${xRes}/${yRes}/ `); 
	return videoOptions;
}

async function createTestPatternArgs(){
    const relayHost = await getWebsocketRelayHost();
    const videoPort = await getVideoPort();
    var videoOptions = ["-f", "lavfi", "-i", `testsrc=duration=9999:size=${xRes}x${yRes}:rate=30`];
    videoOptions.push("-vf", `"drawtext=fontfile=/home/pi/letsrobot-node/letsrobot/fonts/VeraMono.ttf:x=10:y=300:fontcolor=white:box=1:boxcolor=0x00000000@1:text='The video process has failed to start ${recentVideoRestarts} times.'"`);

    videoOptions.push("-f", "mpegts");
    videoOptions.push("-codec:v", "mpeg1video"); 				//Output Codec
    videoOptions.push("-b:v", "350k"); 		                    //Bitrate
    videoOptions.push("-bf", "0"); 								//B-Frames
    videoOptions.push("-muxdelay", "0.001"); 					//Maximum Demux-decode Delay.
    videoOptions.push(`http://${relayHost.host}:${videoPort}/${config.get("StreamKey")}/${xRes}/${yRes}/ `);
    return videoOptions;
}

//ffmpeg -f gdigrab -framerate 10 -i desktop
async function createScreencapArgs(){
    const relayHost = await getWebsocketRelayHost();
    const videoPort = await getVideoPort();
    const videoFilters = createVideoFilters();
    var videoOptions = ["-f", "gdigrab"];
    videoOptions.push("-i", config.get("ScreencapSettings")); 						//Input Device
    if(videoFilters)
        videoOptions.push(videoFilters[0], videoFilters[1]);
    videoOptions.push("-f", "mpegts"); 							//Output Format
    videoOptions.push("-codec:v", "mpeg1video"); 				//Output Codec
    videoOptions.push("-b:v", config.get("VideoBitrate")); 		//Bitrate
    videoOptions.push("-bf", "0"); 								//B-Frames
    videoOptions.push("-muxdelay", "0.001"); 					//Maximum Demux-decode Delay.
    videoOptions.push(`http://${relayHost.host}:${videoPort}/${config.get("StreamKey")}/${xRes}/${yRes}/ `);
    return videoOptions;
}


async function createMicrophoneArgs(){
	const relayHost = await getWebsocketRelayHost();
	const audioPort = await getAudioPort();

    var audioOptions = ["-f"];
    audioOptions.push(os.type === "Windows_NT" ? "dshow" : "alsa");
	audioOptions.push("-ar", config.get("AudioFrequency")); 			//Audio Sampling Frequency			
	audioOptions.push("-ac", config.get("MicrophoneChannels")); 		//Microphone Channels	
	audioOptions.push("-i", `hw:${config.get("MicrophoneDevice")}`);	//Input Device		
	audioOptions.push("-f", "mpegts");									//Output Format
	audioOptions.push("-codec:a", "mp2");								//Output Codec
	audioOptions.push("-b:a", config.get("AudioBitrate"));				//Bitrate
	audioOptions.push("-muxdelay", "0.001"); 							//Maximum Demux-decode Delay.

	
	audioOptions.push(`http://${relayHost.host}:${audioPort}/${config.get("StreamKey")}/${xRes}/${yRes}/ `); 
	return audioOptions;
}


async function createMp3Args(){
	const relayHost = await getWebsocketRelayHost();
	const audioPort = await getAudioPort();

	var audioOptions = ["-f", "mp3", "-re"];
	audioOptions.push("-i", audioPath);	//Input Device
	audioOptions.push("-f", "mpegts");									//Output Format
	audioOptions.push("-codec:a", "mp2");								//Output Codec
	audioOptions.push("-b:a", config.get("AudioBitrate"));				//Bitrate
	audioOptions.push("-muxdelay", "0.001"); 							//Maximum Demux-decode Delay.

	
	audioOptions.push(`http://${relayHost.host}:${audioPort}/${config.get("StreamKey")}/${xRes}/${yRes}/ `); 
	return audioOptions;
}

async function createStreamAudio(){
	const relayHost = await getWebsocketRelayHost();
	const audioPort = await getAudioPort();


	var audioOptions = [];
	audioOptions.push("-r", config.get("Framerate")); 			//Input Framerate
	audioOptions.push("-buffer_size", "500000");
	audioOptions.push("-i", streamPath); 						//Input Device
	audioOptions.push("-f", "mpegts"); 							//Output Format
	audioOptions.push("-codec:a", "mp2"); 				//Output Codec
	audioOptions.push("-b:a", config.get("AudioBitrate"));				//Bitrate
	audioOptions.push(`http://${relayHost.host}:${audioPort}/${config.get("StreamKey")}/${xRes}/${yRes}/ `);
	return audioOptions;
}

async function startAudio(){
	if(audioProcess){
		kill(audioProcess.pid);
		return;
	}


	console.log("Starting Audio");

	var audioArgs;

	if(audioType === "none")
	    return;
	if(audioType === "microphone")
		audioArgs = await createMicrophoneArgs();
	else if(audioType === "mp3")
		audioArgs = await createMp3Args();
	else if(audioType === "stream")
		audioArgs = await createStreamAudio();
	


	audioProcess = child_process.spawn("ffmpeg", audioArgs);

	audioProcess.stdout.on('data', function(data){
		console.log("A: "+data.toString());
	});

	audioProcess.stderr.on('data', function(data){
		console.error("A: "+data.toString());
	});

	audioProcess.on('close', (code) => {
  		console.log(`Audio Process exited with code ${code}`);
  		audioProcess = null;
  		setTimeout(startAudio, 1000);
	});
}




async function startVideo(){
	if(videoProcess){
		console.log("Killing video");
		kill(videoProcess.pid)('SIGTERM');
		return;
	}

	console.log("Starting Video");

	var videoArgs;
	if(videoType === "none")
		return;
	if(videoType === "camera")
		videoArgs = await createCameraArgs();
	else if(videoType === "stream")
		videoArgs = await createStreamArgs();
	else if(videoType === "image")
		videoArgs = await createImageArgs();
    else if(videoType === "screencap")
        videoArgs = await createScreencapArgs();
    else if(videoType === "failsafe")
        videoArgs = await createTestPatternArgs();

    console.log("ffmpeg "+(videoArgs.join(" ")));
	videoProcess = child_process.spawn("ffmpeg", videoArgs, {shell: true, detached: true});

	videoProcess.stdout.on('data', function(data){
		console.log("V: "+data.toString());
	});

	videoProcess.stderr.on('data', function(data){
	    const message = data.toString();
	    if(message.indexOf("error") > -1)videoError +=message+"\n";
		console.error("V: "+message);
	});

	videoProcess.on('close', (code) => {
  		console.log(`Video Process exited with code ${code}`);
  		videoProcess =null;
  		recentVideoRestarts++;
  		if(recentVideoRestarts > 2){
  		    console.log("too many video restarts");
  		    videoType = "failsafe";
            setTimeout(startVideo, 1000);
        }else{
            setTimeout(startVideo, 1000);
        }

	});
}



function changeVideoType(to){
	console.log(`Changing video type to ${to}`);
	videoType = to;
	startVideo();
}



function changeAudioType(to){
	console.log(`Changing audio type to ${to}`);
	audioType = to;
	startAudio();
}


async function init(){
	console.log(`Starting Robot ${config.get("RobotID")} Camera ${config.get("CameraID")}`);
	connectToAppServer();
	setOutputSettings();
	await setRobotSettings();
	handleChat();
	startVideo();
	startAudio();

	setInterval(function(){
	    recentVideoRestarts = 0;
    }, 30000);
}


init();