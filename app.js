const io = require ("@pm2/io");
const pm2 = require("pm2");
const async = require("async");
const exec = require('child_process').exec;

let IS_FETCHING = false; // Whether we are currently fetching the latest version for all processes.
let LAST_CHECK = false; // The last time we checked for updates.

async function execute(command) {
	return new Promise((resolve) => {
		exec(command,function(err,stdout,stderr){
			resolve(stdout);
		});
	});
}

/**
 * fetchLatestVersion()
 * Fetches the latest git version for all connected pm2 processes.
 */
async function fetchLatestVersion()
{
	if (IS_FETCHING) return; // Already fetching, skip.

	log("Fetching latest version for all processes..");
	LAST_CHECK = Date.now();

	const githubApiBearerToken = io.getConfig()?.githubApiBearerToken;
	if (githubApiBearerToken === undefined) {
		logError('Empty githubApiBearerToken (pm2 set pm2-auto-puller:githubApiBearerToken [TOKEN])');
		return ;
	}

	return new Promise(async (resolve, reject) => {
		// Fetch all processes.
		pm2.list((error, allProcesses) => {
			if (error) {
				console.error("[pm2-auto-pull]: Error whilst fetching process list!", error);
				IS_FETCHING = false;
				return reject(error);
			}

			// Keep track of each process we check and their outcome.
			let fetchStats = { checked: [], updated: [], skipped: [] }

			// Iterate through all processes and pull latest version.
			async.forEachLimit(allProcesses, 1, (process, next) => {
				fetchStats.checked.push(process.name);
				if (
					process?.pm2_env?.versioning?.repo_path === undefined
				) {
					logError(`${process.name} versioning repo_path not found!`);
					fetchStats.skipped.push(process.name);
					return next();
				}
				if (
					process?.pm2_env.status !== 'online'
				) {
					logError(`${process.name} status not online => ${process?.pm2_env.status}`);
					fetchStats.skipped.push(process.name);
					return next();
				}
				log(`Process Path => ${process?.pm2_env?.versioning?.repo_path}`);
				log(`process Status => ${process.name} - ${process?.pm2_env.status}`)
				log(`Fetching updates for ${process.name}..`);
				execute(`cd ${process?.pm2_env?.versioning?.repo_path} && git -c credential.helper='!f() { echo "username=ninja"; echo "password=${githubApiBearerToken}"; }; f' fetch`)
					.then((fetchResult) => {
						log(`Fetching branchName for ${process.name}..`);
						execute(`cd ${process?.pm2_env?.versioning?.repo_path} && git branch --show-current`)
							.then((branch) => {
								execute(`cd ${process?.pm2_env?.versioning?.repo_path} && git diff HEAD...origin/${branch}`)
								.then((diffResult) => {
									if (diffResult === undefined || diffResult.replace(/ /gm, '') === '') {
										log(`No Changes => ${process.name} - ${process?.pm2_env.status}`)
										fetchStats.skipped.push(process.name);
										return next();
									}
									console.log(`Diff Result [${diffResult}]`);
									log(`Pulling updates for ${process.name}..`);

									execute(`cd ${process?.pm2_env?.versioning?.repo_path} && git -c credential.helper='!f() { echo "username=ninja"; echo "password=${githubApiBearerToken}"; }; f' pull`)
									.then((pullResult) => {
										log(`Reload process for ${process.name}..`);
										pm2.reload(process.name, (error, metadata) => {
											if (error) return next(error); // Already up to date.

											if (metadata) log(`Successfully pulled latest version for '${process.name}'!`, true);
											fetchStats.updated.push(process.name);
											return next();
										});
									});
								});
							});
					});
			}, () => {
				// All processes have been checked.
				IS_FETCHING = false;
				log(fetchStats);
				return resolve(fetchStats);
			});
		});
	});
}

/**
 * log(message, [force = false])
 * Logs a message to the console as this module.
 * 
 * @param {String} 	message 	The message to log.
 * @param {Boolean} force 		Whether to force log the message regardless of logging setting.
 */
function log(message, force = false) {
	// if (!force && !io.getConfig()?.logging) return;
	return console.log(`[${(new Date()).toISOString()}] - [pm2-auto-puller]:`, message);
}

function logError(message, force = false) {
	return console.error(`[${(new Date()).toISOString()}] - [pm2-auto-puller]:`, message);
}

// pm2 module configuration and initialization.
io.init({
	human_info: [
		["Update Check Interval", `${io.getConfig()?.interval || 30000}ms`],
		["Last Check", (LAST_CHECK ? new Date(LAST_CHECK).toLocaleString() : "Never")],
		["Verbose Logging", io.getConfig()?.logging ? "Enabled" : "Disabled"],
		["Github API Bearer Token", `${io.getConfig()?.githubApiBearerToken || 'Empty'}`],
	]
}).initModule({}, (error) => {
	if (error) return console.error("[pm2-auto-pull]: Failed to initialize module!", error);

	// Parse interval value.
	let FETCH_INTERVAL = parseInt(io.getConfig()?.interval); // How often to check for updates (in ms)
	if (!FETCH_INTERVAL || FETCH_INTERVAL < 1000) FETCH_INTERVAL = 30000; // Fallback to default if invalid value provided.

	pm2.connect(() => {
		setInterval(fetchLatestVersion, FETCH_INTERVAL); // Start fetching latest version every interval.
		log(`Connected to pm2 instance and now updating git every ${FETCH_INTERVAL}ms!`, true);
	});
});

// Expose pm2 action to manually trigger update check.
io.action("fetch updates", async (callback) => {
	console.log("[Fetch Updates] Manually fetching updates..");
	const fetchStats = await fetchLatestVersion().catch(() => { return callback({ status: "error" }); });

	// Prepare callback message, we only want to include stats in the response if logging is disabled to avoid duplicate output.
	let callbackMessage = { status: "success" }
	if (!io.getConfig()?.logging) callbackMessage = { ...callbackMessage, ...fetchStats };
	return callback(callbackMessage);
});