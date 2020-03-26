/*
  MHTimer Bot
*/
// Import required modules
const { DateTime, Duration, Interval } = require('luxon');
const Discord = require('discord.js');

// Extract type-hinting definitions for Discord classes.
// eslint-disable-next-line no-unused-vars
const { Client, Guild, Message, MessageReaction, RichEmbed, TextChannel, User } = Discord;

// Import our own local classes and functions.
const Timer = require('./modules/timerClass.js');
const {
    oxfordStringifyValues,
    prettyPrintArrayAsString,
    splitString,
    timeLeft,
} = require('./modules/utils');
const Logger = require('./modules/logger');

// Access local URIs, like files.
const fs = require('fs');
// Access external URIs, like @devjacksmith 's tools.
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
// We need more robust CSV handling
const csv_parse = require('csv-parse');

// Convert callbacks to 'Promise' versions
const util = require('util');
const fs_readFile = util.promisify(fs.readFile);
const fs_writeFile = util.promisify(fs.writeFile);

// Globals
const client = new Discord.Client({ disabledEvents: ['TYPING_START'] });
const textChannelTypes = new Set(['text', 'dm', 'group']);
const main_settings_filename = 'data/settings.json',
    timer_settings_filename = 'data/timer_settings.json',
    hunter_ids_filename = 'data/hunters.json',
    reminder_filename = 'data/reminders.json',
    nickname_urls_filename = 'data/nicknames.json';
const file_encoding = 'utf8';

const settings = {},
    mice = [],
    items = [],
    filters = [],
    hunters = {},
    relic_hunter = {
        location: 'unknown',
        source: 'startup',
        last_seen: DateTime.fromMillis(0),
        timeout: null,
    },
    nicknames = new Map(),
    nickname_urls = {};

/** @type {Timer[]} */
const timers_list = [];
/** @type {TimerReminder[]} */
const reminders = [];

const refresh_rate = Duration.fromObject({ minutes: 5 });
/** @type {Object<string, DateTime>} */
const last_timestamps = {
    reminder_save: DateTime.utc(),
    hunter_save: DateTime.utc(),
    item_refresh: null,
    mouse_refresh: null,
    filter_refresh: null,
};

/** @type {Object <string, NodeJS.Timer>} */
const dataTimers = {};
/** @type {Map <string, {active: boolean, channels: TextChannel[], inactiveChannels: TextChannel[]}>} */
const timer_config = new Map();
const emojis = [
    { id: '1%E2%83%A3', text: ':one:' },
    { id: '2%E2%83%A3', text: ':two:' },
    { id: '3%E2%83%A3', text: ':three:' },
    { id: '4%E2%83%A3', text: ':four:' },
    { id: '5%E2%83%A3', text: ':five:' },
    { id: '6%E2%83%A3', text: ':six:' },
    { id: '7%E2%83%A3', text: ':seven:' },
    { id: '8%E2%83%A3', text: ':eight:' },
    { id: '9%E2%83%A3', text: ':nine:' },
    { id: '%F0%9F%94%9F', text: ':keycap_ten:' },
];

process.once('SIGINT', () => {
    client.destroy();
});
process.once('SIGTERM', () => {
    client.destroy();
});

process.on('uncaughtException', exception => {
    Logger.error(exception);
    doSaveAll().then(didSave => Logger.log(`Save status: files ${didSave ? '' : 'maybe '}saved.`));
});

function Main() {
    // Load saved settings data, such as the token for the bot.
    loadSettings()
        .then(hasSettings => {
            if (!hasSettings) {
                process.exitCode = 1;
                throw new Error('Exiting due to failure to acquire local settings data.');
            }
            function failedLoad(prefix, reason) {
                Logger.log(prefix, reason);
                return false;
            }
            // Settings loaded successfully, so initiate loading of other resources.
            const saveInterval = refresh_rate.as('milliseconds');

            // Schedule the daily Relic Hunter reset.
            rescheduleResetRH();

            // Create timers list from the timers file.
            const hasTimers = loadTimers()
                .then(timerData => {
                    createTimersFromList(timerData);
                    Logger.log(`Timers: imported ${timerData.length} from file.`);
                    return timers_list.length > 0;
                })
                .catch(err => failedLoad('Timers: import error:\n', err));

            // Create reminders list from the reminders file.
            const hasReminders = loadReminders()
                .then(reminderData => {
                    if (createRemindersFromData(reminderData))
                        pruneExpiredReminders();
                    Logger.log(`Reminders: imported ${reminderData.length} from file.`);
                    return reminders.length > 0;
                })
                .catch(err => failedLoad('Reminders: import error:\n', err));
            hasReminders.then(() => {
                Logger.log(`Reminders: Configuring save every ${saveInterval / (60 * 1000)} min.`);
                dataTimers['reminders'] = setInterval(() => {
                    pruneExpiredReminders();
                    saveReminders();
                }, saveInterval);
            });

            // Create hunters data from the hunters file.
            const hasHunters = loadHunterData()
                .then(hunterData => {
                    Object.assign(hunters, hunterData);
                    Logger.log(`Hunters: imported ${Object.keys(hunterData).length} from file.`);
                    return Object.keys(hunters).length > 0;
                })
                .catch(err => failedLoad('Hunters: import error:\n', err));
            hasHunters.then(() => {
                Logger.log(`Hunters: Configuring save every ${saveInterval / (60 * 1000)} min.`);
                dataTimers['hunters'] = setInterval(saveHunters, saveInterval);
            });

            // Register known nickname URIs
            const hasNicknames = loadNicknameURLs()
                .then(urls => {
                    Object.assign(nickname_urls, urls);
                    Logger.log(`Nicknames: imported ${Object.keys(urls).length} sources from file.`);
                    return Object.keys(nickname_urls).length > 0;
                })
                .catch(err => failedLoad('Nicknames: import error:\n', err));
            hasNicknames
                .then(refreshNicknameData)
                .then(() => {
                    Logger.log(`Nicknames: Configuring data refresh every ${saveInterval / (60 * 1000)} min.`);
                    dataTimers['nicknames'] = setInterval(refreshNicknameData, saveInterval);
                });

            // Register filters
            const hasFilters = Promise.resolve()
                .then(getFilterList)
                .then(() => {
                    return Object.keys(filters).length > 0;
                })
                .catch(err => failedLoad('Filters: import error:\n', err));
            hasFilters
                .then(() => {
                    Logger.log(`Filters: Configuring refresh every ${saveInterval / (60 * 1000)} min.`);
                    dataTimers['filters'] = setInterval(getFilterList, saveInterval);
                });

            // Start loading remote data.
            const remoteData = [
                getMouseList(),
                getItemList(),
                getRHLocation(),
            ];

            // Configure the bot behavior.
            client.once('ready', () => {
                Logger.log('I am alive!');

                // Find all text channels on which to send announcements.
                const announcables = client.guilds.reduce((channels, guild) => {
                    const candidates = guild.channels
                        .filter(c => settings.timedAnnouncementChannels.has(c.name) && textChannelTypes.has(c.type))
                        .map(tc => tc);
                    if (candidates.length)
                        Array.prototype.push.apply(channels, candidates);
                    else
                        Logger.warn(`Timers: No valid channels in ${guild.name} for announcements.`);
                    return channels;
                }, []);

                // Use one timeout per timer to manage default reminders and announcements.
                timers_list.forEach(timer => scheduleTimer(timer, announcables));
                Logger.log(`Timers: Initialized ${timer_config.size} timers on channels ${announcables}.`);

                // If we disconnect and then reconnect, do not bother rescheduling the already-scheduled timers.
                client.on('ready', () => Logger.log('I am inVINCEeble!'));
            });

            // Message handling.
            const re = new RegExp('^' + settings.botPrefix + '\\s');
            client.on('message', message => {
                if (message.author.id === client.user.id)
                    return;

                if (message.webhookID === settings.relic_hunter_webhook)
                    handleRHWebhook(message);

                switch (message.channel.name) {
                    case settings.linkConversionChannel:
                        if (/(http[s]?:\/\/htgb\.co\/)/g.test(message.content.toLowerCase()))
                            convertRewardLink(message);
                        break;
                    default:
                        if (message.channel.type === 'dm')
                            parseUserMessage(message);
                        else if (re.test(message.content))
                            parseUserMessage(message);
                        break;
                }
            });

            // WebSocket connection error for the bot client.
            client.on('error', error => {
                Logger.error(`Discord Client Error Received: "${error.message}"\n`, error.error);
            //    quit(); // Should we? or just let it attempt to reconnect?
            });

            client.on('reconnecting', () => Logger.log('Connection lost, reconnecting to Discord...'));
            // WebSocket disconnected and is no longer trying to reconnect.
            client.on('disconnect', event => {
                Logger.log(`Client socket closed: ${event.reason || 'No reason given'}`);
                Logger.log(`Socket close code: ${event.code} (${event.wasClean ? '' : 'not '}cleanly closed)`);
                quit();
            });
            // Configuration complete. Using Promise.all() requires these tasks to complete
            // prior to bot login.
            return Promise.all([
                hasFilters,
                hasHunters,
                hasNicknames,
                hasReminders,
                hasTimers,
                ...remoteData,
            ]);
        })
        // Finally, log in now that we have loaded all data from disk,
        // requested data from remote sources, and configured the bot.
        .then(() => client.login(settings.token))
        .catch(err => {
            Logger.error('Unhandled startup error, shutting down:', err);
            client.destroy()
                .then(() => process.exitCode = 1);
        });
}
try {
    Main();
}
catch(error) {
    Logger.error('Error executing Main:\n', error);
}

function quit() {
    return doSaveAll()
        .then(
            () => Logger.log('Shutdown: data saves completed'),
            (err) => Logger.error('Shutdown: error while saving:\n', err),
        )
        .then(() => { Logger.log('Shutdown: destroying client'); return client.destroy(); })
        .then(() => {
            Logger.log('Shutdown: deactivating data refreshes');
            for (const timer of Object.values(dataTimers))
                clearInterval(timer);
            Logger.log('Shutdown: deactivating timers');
            for (const timer of timers_list) {
                timer.stopInterval();
                timer.stopTimeout();
            }
            if (relic_hunter.timeout) {
                clearTimeout(relic_hunter.timeout);
            }
        })
        .then(() => process.exitCode = 1)
        .catch(err => {
            Logger.error('Shutdown: unhandled error:\n', err, '\nImmediately exiting.');
            process.exit();
        });
}

/**
 * Generic Promise-based file read.
 * Returns the data as an object, or the error that occurred when reading and parsing the file.
 * A common error code will be 'ENOENT' (the file did not exist).
 *
 * @param {string} filename the name of a file in the current working directory (or a path and the name)
 *                          from which raw data will be read, and then parsed as JSON.
 * @returns {Promise <any>}  Data from the given file, as an object to be consumed by the caller.
 */
function loadDataFromJSON(filename) {
    return fs_readFile(filename, { encoding: file_encoding })
        .then(data => {
            Logger.log(`I/O: data read from '${filename}'.`);
            return data;
        }).then(rawData => JSON.parse(rawData));
}
/**
 * Generic Promise-based file write.
 * Returns true if the file was written without error.
 * Returns false if an error occurred. Depending on the error, the data may have been written anyway.
 *
 * @param {string} filename the name of a file in the current working directory (or a path and the name)
 *                          to which data will be serialized as JSON.
 * @param {any} rawData raw object data which can be serialized as JSON, via JSON.stringify()
 * @returns {Promise <boolean>} The result of the save request (false negatives possible).
 */
function saveDataAsJSON(filename, rawData) {
    return fs_writeFile(filename, JSON.stringify(rawData, null, 1), { encoding: file_encoding })
        .then(() => {
            Logger.log(`I/O: data written to '${filename}'.`);
            return true;
        }).catch(err => {
            Logger.error(`I/O: error writing to '${filename}':\n`, err);
            return false;
        });
}

/**
 * Any object which stores user-entered data should be periodically saved, or at minimum saved before
 * the bot shuts down, to minimize data loss.
 * @returns {boolean} Whether volatile data was serialized, or perhaps not serialized.
 */
function doSaveAll() {
    return saveHunters()
        .then(() => saveReminders());
}



/**
 * Load (or reload) settings from the input path, defaulting to the value of 'main_settings_filename'.
 * Any keys in the global settings object will be overwritten if they are defined in the file.
 *
 * @param {string} [path] The path to a JSON file to read data from. Default is the 'main_settings_filename'.
 * @returns {Promise <boolean>} Whether the read was successful.
 */
function loadSettings(path = main_settings_filename) {
    return loadDataFromJSON(path).then(data => {
        // (Re)initialize any keys to the value specified in the file.
        Object.assign(settings, data);
        // Set defaults if they were not specified.
        if (!settings.linkConversionChannel)
            settings.linkConversionChannel = 'larrys-freebies';

        if (!settings.timedAnnouncementChannels)
            settings.timedAnnouncementChannels = ['timers'];
        if (!Array.isArray(settings.timedAnnouncementChannels))
            settings.timedAnnouncementChannels = settings.timedAnnouncementChannels.split(',').map(s => s.trim());
        settings.timedAnnouncementChannels = new Set(settings.timedAnnouncementChannels);

        settings.relic_hunter_webhook = settings.relic_hunter_webhook || '283571156236107777';

        settings.botPrefix = settings.botPrefix ? settings.botPrefix.trim() : '-mh';

        settings.owner = settings.owner || '0'; // So things don't fail if it's unset
        return true;
    }).catch(err => {
        Logger.error(`Settings: error while reading settings from '${path}':\n`, err);
        return false;
    });
}

/**
 * Load timer data from the input path, defaulting to the value of 'timer_settings_filename'.
 * Returns an array of data objects (or an empty array if there was an error reading the file)
 * that can be made into timers.
 *
 * @param {string} [path] The path to a JSON file to read data from. Default is the 'timer_settings_filename'
 * @returns {Promise <TimerSeed[]>} All local information for creating timers
 */
function loadTimers(path = timer_settings_filename) {
    return loadDataFromJSON(path).then(data => {
        return Array.isArray(data) ? data : Array.from(data);
    }).catch(err => {
        Logger.error(`Timers: error during load from '${path}'. None loaded.\n`, err);
        return [];
    });
}

/**
 * Create Timer objects from the given array input.
 * Returns true if any timers were created, false if none were created.
 *
 * @param {TimerSeed[]} timerData An array containing data objects, each of which can create a timer, e.g. a timer "seed"
 * @returns {boolean} Whether or not any timers were created from the input.
 */
function createTimersFromList(timerData) {
    const knownTimers = timers_list.length;
    for (const seed of timerData) {
        let timer;
        try {
            timer = new Timer(seed);
        } catch (err) {
            Logger.error(`Timers: error occured while constructing timer: '${err}'. Received object:\n`, seed);
            continue;
        }
        timers_list.push(timer);
    }
    return timers_list.length !== knownTimers;
}

/**
 * Create the timeout (and interval) that will activate this particular timer, in order to send
 * its default announcement and its default reminders.
 *
 * @param {Timer} timer The timer to schedule.
 * @param {TextChannel[]} channels the channels on which this timer will initially perform announcements.
 */
function scheduleTimer(timer, channels) {
    if (timer.isSilent())
        return;
    const msUntilActivation = timer.getNext().diffNow().minus(timer.getAdvanceNotice()).as('milliseconds');
    timer.storeTimeout('scheduling',
        setTimeout(t => {
            t.stopTimeout('scheduling');
            t.storeInterval('scheduling',
                setInterval(timer => {
                    doRemind(timer);
                    doAnnounce(timer);
                }, t.getRepeatInterval().as('milliseconds'), t),
            );
            doRemind(t);
            doAnnounce(t);
        }, msUntilActivation, timer),
    );
    timer_config.set(timer.id, { active: true, channels: channels, inactiveChannels: [] });
}

/**
 * Inspects the current timers list to dynamically determine the text to print when informing users
 * of what timers are available.
 *
 * @returns {string} a ready-to-print string of timer details, with each timer on a new line.
 */
function getKnownTimersDetails() {
    // Prepare a detailed list of known timers and their sub-areas.
    /** @type {Object <string, Set<string>> */
    const details = {};
    timers_list.forEach(timer => {
        const area = `**${timer.getArea()}**`;
        if (!details[area])
            details[area] = new Set();
        if (timer.getSubArea())
            details[area].add(timer.getSubArea());
    });
    const names = [];
    for (const area in details) {
        let description = area;
        if (details[area].size)
            description += ` (${Array.from(details[area]).join(', ')})`;
        names.push(description);
    }

    return names.join('\n');
}

/**
 * The meat of user interaction. Receives the message that starts with the magic
 * character and decides if it knows what to do next.
 *
 * @param {Message} message a Discord message to parse
 */
function parseUserMessage(message) {
    const tokens = splitString(message.content);
    if (!tokens.length) {
        message.channel.send('What is happening???');
        return;
    }

    // Messages that come in from public chat channels will be prefixed with the bot's command prefix.
    if (tokens[0] === settings.botPrefix.trim())
        tokens.shift();

    const command = tokens.shift();
    if (!command) {
        message.channel.send('I didn\'t understand, but you can ask me for help.');
        return;
    }

    // Parse the message to see if it matches any known timer areas, sub-areas, or has count information.
    const reminderRequest = tokens.length ? timerAliases(tokens) : {};

    switch (command.toLowerCase()) {
        // Display information about the next instance of a timer.
        case 'next': {
            const aboutTimers = `I know these timers:\n${getKnownTimersDetails()}`;
            if (!tokens.length) {
                // received "-mh next" -> display the help string.
                // TODO: pretty-print known timer info
                message.channel.send(aboutTimers);
            } else if (!reminderRequest.area) {
                // received "-mh next <words>", but the words didn't match any known timer information.
                // Currently, the only other information we handle is RONZA.
                switch (tokens[0].toLowerCase()) {
                    case 'ronza':
                        message.channel.send('Don\'t let aardwolf see you ask or you\'ll get muted');
                        // TODO: increment hunters[id] info? "X has delayed ronza by N years for asking M times"
                        break;
                    default:
                        message.channel.send(aboutTimers);
                }
            } else {
                // Display information about this known timer.
                const timerInfo = nextTimer(reminderRequest);
                if (typeof timerInfo === 'string')
                    message.channel.send(timerInfo);
                else
                    message.channel.send('', { embed: timerInfo });
            }
            break;
        }

        // Display or update the user's reminders.
        case 'remind':
            // TODO: redirect responses to PM.
            if (!tokens.length || !reminderRequest.area)
                listRemind(message);
            else
                addRemind(reminderRequest, message);
            break;

        // Display information about upcoming timers.
        case 'sched':
        case 'itin':
        case 'agenda':
        case 'itinerary':
        case 'schedule': {
            // Default the searched time period to 24 hours if it was not specified.
            reminderRequest.count = reminderRequest.count || 24;

            const usage_str = buildSchedule(reminderRequest);
            // Discord limits messages to 2000 characters, so use multiple messages if necessary.
            message.channel.send(usage_str, { split: true });
            break;
        }
        // Display information about the desired mouse.
        case 'find':
        case 'mfind':
            if (!tokens.length)
                message.channel.send('You have to supply mice to find.');
            else {
                const criteria = tokens.join(' ').trim().toLowerCase().replace(/ mouse$/,'');
                if (criteria.length < 2)
                    message.channel.send('Your search string was too short, try again.');
                else
                    findMouse(message.channel, criteria, 'find');
            }
            break;

        // Display information about the desired item.
        case 'ifind':
            if (!tokens.length)
                message.channel.send('You have to supply an item to find');
            else {
                const criteria = tokens.join(' ').trim().toLowerCase();
                if (criteria.length < 2)
                    message.channel.send('Your search string was too short, try again.');
                else
                    findItem(message.channel, criteria, 'ifind');
            }
            break;

        // Update information about the user volunteered by the user.
        case 'iam':
            if (!tokens.length)
                message.channel.send('Yes, you are. Provide a hunter ID number to set that.');
            else if (tokens.length === 1 && !isNaN(parseInt(tokens[0], 10)))
                setHunterID(message, tokens[0]);
            else if (tokens.length === 1 && tokens[0].toLowerCase() === 'not')
                unsetHunterID(message);
            else {
                // received -mh iam <words>. The user can specify where they are hunting, their rank/title, or their in-game id.
                // Nobody should need this many tokens to specify their input, but someone is gonna try for more.
                let userText = tokens.slice(1, 10).join(' ').trim().toLowerCase();
                const userCommand = tokens[0].toLowerCase();
                if (userCommand === 'in' && userText) {
                    if (nicknames.get('locations')[userText])
                        userText = nicknames.get('locations')[userText];
                    setHunterProperty(message, 'location', userText);
                }
                else if (['rank', 'title', 'a'].indexOf(userCommand) !== -1 && userText) {
                    if (nicknames.get('ranks')[userText])
                        userText = nicknames.get('ranks')[userText];
                    setHunterProperty(message, 'rank', userText);
                }
                else if (userCommand.substring(0, 3) === 'snu' && userText)
                    setHunterProperty(message, 'snuid', userText);
                else {
                    const prefix = settings.botPrefix;
                    const commandSyntax = [
                        'I\'m not sure what to do with that. Try:',
                        `\`${prefix} iam ####\` to set a hunter ID.`,
                        `\`${prefix} iam rank <rank>\` to set a rank.`,
                        `\`${prefix} iam in <location>\` to set a location`,
                        `\`${prefix} iam snuid ####\` to set your in-game user id`,
                        `\`${prefix} iam not\` to unregister (and delete your data)`,
                    ];
                    message.channel.send(commandSyntax.join('\n\t'));
                }
            }
            break;

        /**
         * Display volunteered information about known users. Handled inputs:
         * -mh whois ####                   -> hid lookup (No PM)
         * -mh whois snuid ####             -> snuid lookup (No PM)
         * -mh whois <word/@mention>        -> name lookup (No PM)
         * -mh whois in <words>             -> area lookup
         * -mh whois [rank|title|a] <words> -> random query lookup
         */
        case 'whois': {
            if (!tokens.length) {
                message.channel.send('Who\'s who? Who\'s on first?');
                return;
            }

            let searchType = tokens.shift().toLowerCase();
            if (!isNaN(parseInt(searchType, 10))) {
                // hid lookup of 1 or more IDs.
                tokens.unshift(searchType);
                findHunter(message, tokens, 'hid');
                return;
            }
            else if (searchType.substring(0, 3) === 'snu') {
                // snuid lookup of 1 or more IDs.
                findHunter(message, tokens, 'snuid');
                return;
            }
            else if (!tokens.length) {
                // Display name or user mention lookup.
                tokens.unshift(searchType);
                findHunter(message, tokens, 'name');
                return;
            }
            else {
                // Rank or location lookup. tokens[] contains the terms to search
                let search = tokens.join(' ').toLowerCase();
                if (searchType === 'in') {
                    if (nicknames.get('locations')[search]) {
                        search = nicknames.get('locations')[search];
                    }
                    searchType = 'location';
                }
                else if (['rank', 'title', 'a', 'an'].indexOf(searchType) !== -1) {
                    if (nicknames.get('ranks')[search]) {
                        search = nicknames.get('ranks')[search];
                    }
                    searchType = 'rank';
                }
                else {
                    const prefix = settings.botPrefix;
                    const commandSyntax = [
                        'I\'m not sure what to do with that. Try:',
                        `\`${prefix} whois [#### | <mention>]\` to look up specific hunters`,
                        `\`${prefix} whois [in <location> | a <rank>]\` to find up to 5 random new friends`,
                    ];
                    message.channel.send(commandSyntax.join('\n\t'));
                    return;
                }
                const hunters = getHuntersByProperty(searchType, search);
                message.channel.send(hunters.length
                    // eslint-disable-next-line no-useless-escape
                    ? `${hunters.length} random hunters: \`${hunters.join('\`, \`')}\``
                    : `I couldn't find any hunters with \`${searchType}\` matching \`${search}\``,
                );
            }
            break;
        }
        case 'reset':
            if (message.author.id === settings.owner) {
                if (!tokens.length) {
                    message.channel.send('I don\'t know what to reset.');
                }
                const sub_command = tokens.shift();
                switch (sub_command) {
                    case 'timers':
                        // TODO: re-add deactivated channels to active channels for each timer.
                        break;

                    case 'rh':
                    case 'relic_hunter':
                    default:
                        resetRH();
                }
                break;
            }
        // Fall through if user isn't the bot owner.
        case 'help':
        case 'arrg':
        case 'aarg':
        default: {
            const helpMessage = getHelpMessage(tokens);
            // TODO: Send help to PM?
            message.channel.send(helpMessage ? helpMessage : 'Whoops! That\'s a bug.');
        }
    }
}

/**
 * Convert a HitGrab shortlink into a BitLy shortlink that does not send the clicker to Facebook.
 * If successful, sends the converted link to the same channel that received the input message.
 *
 * @param {Message} message a Discord message containing at least one htgb.co URL.
 */
async function convertRewardLink(message) {
    if (!settings.bitly_token) {
        Logger.warn(`Links: Received link to convert, but don't have a valid 'bitly_token' specified in settings: ${settings}.`);
        return;
    }

    const links = message.content.replace(/[<>]/gm,'').split(/\s|\n/).map(t => t.trim()).filter(text => /^(http[s]?:\/\/htgb\.co\/).*/g.test(text));
    const newLinks = (await Promise.all(links.map(async link => {
        const target = await getHGTarget(link);
        if (target) {
            const shortLink = await getBitlyLink(target);
            return shortLink ? { fb: link, mh: shortLink } : '';
        } else {
            return '';
        }
    }))).filter(nl => !!nl);
    if (!newLinks.length)
        return;

    let response = `<${newLinks[0].mh}> <-- Non-Facebook Link`;
    if (newLinks.length > 1) {
        // Print both old and new link on same line:
        response = 'Facebook Link --> Non-Facebook Link:\n';
        response += newLinks.map(linkData => `<${linkData.fb}> --> <${linkData.mh}>`).join('\n');
    }

    message.channel.send(response);

    /** Get the redirect url from htgb.co
     * @param {string} url A htgb.co link to be shortened.
     * @returns {Promise<string>} A mousehuntgame.com link that should be converted.
     */
    function getHGTarget(url) {
        return fetch(url, { redirect: 'manual' }).then((response) => {
            if (response.status === 301) {
                const facebookURL = response.headers.get('location');
                return facebookURL.replace('https://apps.facebook.com/mousehunt', 'https://www.mousehuntgame.com');
            } else {
                throw `HTTP ${response.status}`;
            }
        }).catch((err) => Logger.error('Links: GET to htgb.co failed with error', err))
            .then(result => result || '');
    }

    /**
     * Shorten the given link using the Bit.ly API.
     * @param {string} url The link to be shortened.
     * @returns {Promise<string>} A bit.ly link with the same resolved address, except to a non-Facebook site.
     */
    function getBitlyLink(url) {
        const options = {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${settings.bitly_token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ long_url: url }),
        };
        return fetch('https://api-ssl.bitly.com/v4/shorten', options).then(async (response) => {
            if ([200, 201].includes(response.status)) {
                const { link } = await response.json();
                return link;
            } else {
                // TODO: API rate limit error handling? Could delegate to caller. Probably not an issue with this bot.
                throw `HTTP ${response.status}`;
            }
        }).catch((err) => Logger.error('Links: Bitly shortener failed with error:', err))
            .then(result => result || '');
    }
}

/**
 * @typedef {Object} ReminderRequest
 * @property {string} [area] The area of a Timer
 * @property {string} [sub_area] The sub-area of a Timer
 * @property {number} [count] The number of times a Timer should activate before this reminder is removed.
 */

/**
 * Attempt to find a Timer that satisfies the input tokens.
 * Returns a ReminderRequest of unknown state (may have some or all properties set).
 *
 * @param {string[]} tokens a set of tokens which may match known Timer areas or sub-areas.
 * @returns {ReminderRequest} an object that may have some or all of the needed properties to create a Reminder
 */
function timerAliases(tokens) {
    const newReminder = {
        area: null,
        sub_area: null,
        count: null,
    };
    const timerAreas = timers_list.map(timer => timer.getArea());
    const timerSubAreas = timers_list.map(timer => timer.getSubArea());
    // Scan the input tokens and attempt to match them to a known timer.
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i].toLowerCase();

        // Check if this is an exact timer name, useful if we can dynamically add new timers.
        const areaIndex = timerAreas.indexOf(token);
        if (areaIndex !== -1) {
            newReminder.area = token;
            continue;
        } else {
            const subIndex = timerSubAreas.indexOf(token);
            if (subIndex !== -1) {
                newReminder.area = timerAreas[subIndex];
                newReminder.sub_area = token;
                continue;
            }
        }

        // Attempt to find an area from this token
        if (!newReminder.area && parseTokenForArea(token, newReminder))
            continue;

        // Attempt to find a sub-area from this token.
        if (!newReminder.sub_area && parseTokenForSubArea(token, newReminder))
            continue;

        // Attempt to find a count from this token.
        if (!newReminder.count && parseTokenForCount(token, newReminder))
            continue;

        // Upon reaching here, the token has no area, sub-area, or count information, or those fields
        // were already set, and thus it was not parsed for them.
        if (newReminder.area && newReminder.sub_area && newReminder.count !== null) {
            Logger.log(`MessageHandling: got an extra token '${String(token)}' from user input '${tokens}'.`);
            break;
        }
    }

    return newReminder;
}

/**
 * Attempt to match the input string to known Timer areas. If successful, updates the given reminder.
 *
 * @param {string} token a word or phrase from a Discord message
 * @param {ReminderRequest} newReminder the reminder request being built from the entirety of the input Discord message
 * @returns {boolean} if the token parsed to an area.
 */
function parseTokenForArea(token, newReminder) {
    switch (token) {
        // Seasonal Garden aliases
        case 'sg':
        case 'seasonal':
        case 'season':
        case 'garden':
            newReminder.area = 'sg';
            break;

        // Forbidden Grove aliases
        case 'fg':
        case 'grove':
        case 'gate':
        case 'ar':
        case 'acolyte':
        case 'ripper':
        case 'realm':
            newReminder.area = 'fg';
            break;

        // Game Reset
        case 'reset':
        case 'game':
        case 'midnight':
            newReminder.area = 'reset';
            break;

        case 'rh':
        case 'rhm':
        case 'relic':
            newReminder.area = 'relic_hunter';
            break;

        // Balack's Cove aliases
        case 'cove':
        case 'balack':
        case 'tide':
            newReminder.area = 'cove';
            break;

        // Toxic Spill aliases
        case 'spill':
        case 'toxic':
        case 'ts':
            newReminder.area = 'spill';
            break;

        // This token is not a known timer area.
        default:
            return false;
    }
    return true;
}

/**
 * Attempt to match the input string to known Timer sub-areas. If successful, updates the given reminder.
 * Overwrites any previously-specified area.
 *
 * @param {string} token an input string from the user's message.
 * @param {ReminderRequest} newReminder the seed for a new reminder that will be updated.
 * @returns {boolean} if the token parsed to a sub-area.
 */
function parseTokenForSubArea(token, newReminder) {
    switch (token) {
        // Seasonal Garden seasons aliases.
        case 'fall':
        case 'autumn':
            newReminder.area = 'sg';
            newReminder.sub_area = 'autumn';
            break;
        case 'spring':
            newReminder.area = 'sg';
            newReminder.sub_area = 'spring';
            break;
        case 'summer':
            newReminder.area = 'sg';
            newReminder.sub_area = 'summer';
            break;
        case 'winter':
            newReminder.area = 'sg';
            newReminder.sub_area = 'winter';
            break;

        // Forbidden Grove gate state aliases.
        case 'open':
        case 'opens':
        case 'opened':
        case 'opening':
            newReminder.area = 'fg';
            newReminder.sub_area = 'open';
            break;
        case 'close':
        case 'closed':
        case 'closing':
        case 'shut':
            newReminder.area = 'fg';
            newReminder.sub_area = 'close';
            break;

        // Balack's Cove tide aliases.
        case 'low-tide':
        case 'lowtide':
        case 'low':
            newReminder.area = 'cove';
            newReminder.sub_area = 'low';
            break;
        case 'mid-tide':
        case 'midtide':
        case 'mid':
            newReminder.area = 'cove';
            newReminder.sub_area = 'mid';
            break;
        case 'high-tide':
        case 'hightide':
        case 'high':
            newReminder.area = 'cove';
            newReminder.sub_area = 'high';
            break;

        // Toxic Spill severity level aliases.
        case 'archduke':
        case 'ad':
        case 'archduchess':
        case 'aardwolf':
        case 'arch':
            newReminder.area = 'spill';
            newReminder.sub_area = 'arch';
            break;
        case 'grandduke':
        case 'gd':
        case 'grandduchess':
        case 'grand':
            newReminder.area = 'spill';
            newReminder.sub_area = 'grand';
            break;
        case 'duchess':
        case 'duke':
            newReminder.area = 'spill';
            newReminder.sub_area = 'duke';
            break;
        case 'countess':
        case 'count':
            newReminder.area = 'spill';
            newReminder.sub_area = 'count';
            break;
        case 'baronness':
        case 'baron':
            newReminder.area = 'spill';
            newReminder.sub_area = 'baron';
            break;
        case 'lady':
        case 'lord':
            newReminder.area = 'spill';
            newReminder.sub_area = 'lord';
            break;
        case 'heroine':
        case 'hero':
            newReminder.area = 'spill';
            newReminder.sub_area = 'hero';
            break;

        // This token did not match any known Timer sub-areas.
        default:
            return false;
    }
    return true;
}

/**
 * Attempt to match the input string to a positive integer. If successful, updates the given reminder.
 * Overwrites any previously-specified count.
 *
 * @param {string} token an input string from the user's message.
 * @param {ReminderRequest} newReminder the seed for a new reminder that will be updated.
 * @returns {boolean} if the token parsed to a valid count.
 */
function parseTokenForCount(token, newReminder) {
    switch (token) {
        // Words for numbers...
        case 'once':
        case 'one':
            newReminder.count = 1;
            break;

        case 'twice':
        case 'two':
            newReminder.count = 2;
            break;

        case 'thrice':
        case 'three':
            newReminder.count = 3;
            break;

        case 'always':
        case 'forever':
        case 'unlimited':
        case 'inf':
        case 'infinity':
            newReminder.count = -1;
            break;

        case 'never':
        case 'end':
        case 'forget':
        case 'quit':
        case 'stop':
            newReminder.count = 0;
            break;

        // If it is an actual number, then we can just use it as normal. Note that parseInt will
        // take garbage input like unrepresentably large numbers and coerce to + /-Infinity.
        default:
            if (!isNaN(parseInt(token, 10))) {
                let val = parseInt(token, 10);
                if (val === Infinity || val < 0)
                    val = -1;
                newReminder.count = val;
                break;
            }
            return false;
    }
    return true;
}

/**
 * Returns the next occurrence of the desired class of timers as a RichEmbed.
 *
 * @param {ReminderRequest} validTimerData Validated input that is known to match an area and subarea
 * @returns {RichEmbed} A rich snippet summary of the next occurrence of the matching timer.
 */
function nextTimer(validTimerData) {
    // Inspect all known timers to determine the one that matches the requested area, and occurs soonest.
    const area = validTimerData.area,
        sub = validTimerData.sub_area,
        areaTimers = timers_list.filter(timer => timer.getArea() === area);

    let nextTimer;
    for (const timer of areaTimers)
        if (!sub || sub === timer.getSubArea())
            if (!nextTimer || timer.getNext() < nextTimer.getNext())
                nextTimer = timer;

    const sched_syntax = `${settings.botPrefix} remind ${area}${sub ? ` ${sub}` : ''}`;
    return (new Discord.RichEmbed()
        .setDescription(nextTimer.getDemand()
            + `\n${timeLeft(nextTimer.getNext())}`
            // Putting here makes it look nicer and fit in portrait mode
            + `\nTo schedule this reminder: \`${sched_syntax}\``,
        )
        .setTimestamp(nextTimer.getNext().toJSDate())
        .setFooter('at') // There has to be something in here or there is no footer
    );
}

/**
 * @typedef {Object} TimerReminder
 * @property {User} user The Discord user who requested the reminder.
 * @property {number} count The number of remaining times this reminder will activate.
 * @property {string} area The area to which this reminder applies, e.g. "fg"
 * @property {string} [sub_area] A logical "location" within the area, e.g. "close" or "open" for Forbidden Grove.
 * @property {number} [fail] The number of times this particular reminder encountered an error (during send, etc.)
 */

/**
 * Load reminder data from the input path, defaulting to the value of 'reminder_filename'.
 * Returns an array of data objects (or an empty array if there was an error reading the file)
 * that can be made into reminders.
 *
 * @param {string} [path] The path to a JSON file to read data from. Default is the 'reminder_filename'.
 * @returns {Promise <ReminderSeed[]>} Local data that can be used to create reminders.
 */
function loadReminders(path = reminder_filename) {
    return loadDataFromJSON(path).then(data => {
        return Array.isArray(data) ? data : Array.from(data);
    }).catch(err => {
        Logger.error(`Reminders: error during loading from '${path}':\n`, err);
        return [];
    });
}

/**
 * Create reminder objects from the given array input
 * Returns true if any reminders were created, false if none were created.
 *
 * @param {ReminderSeed[]} reminderData An array of data objects, each of which can create a reminder, e.g. a reminder "seed"
 * @returns {boolean} Whether or not any reminders were created from the input.
 */
function createRemindersFromData(reminderData) {
    const knownReminders = reminders.length;
    /** TODO: Reminders as class instead of just formatted object
     * Class instantiation code would be here and replace the push call.
     */
    // Add each of these objects to the reminder list.
    Array.prototype.push.apply(reminders, reminderData);
    return reminders.length !== knownReminders;
}

/**
 * Inspect the reminders list and remove any that are no longer active.
 */
function pruneExpiredReminders() {
    // Remove any expired timers - no need to save them.
    if (reminders.length) {
        // Move expired reminders to the end.
        reminders.sort((a, b) => (a.count === 0) ? 1 : (b.count - a.count));

        // Find the first non-expired one.
        let i = reminders.length,
            numExpired = 0;
        while (i--) {
            if (reminders[i].count === 0)
                ++numExpired;
            else
                break;
        }
        if (numExpired === reminders.length)
            reminders.length = 0;
        else if (numExpired) {
            // Advance to the next record (which should be expired and a valid index).
            ++i;
            // If the current reminder is expired, splice it and the others away.
            if (i < reminders.length && reminders[i].count === 0) {
                const discarded = reminders.splice(i, numExpired);
                Logger.log(`Reminders: spliced ${discarded.length} that were expired. ${reminders.length} remaining.`);
            }
            else
                Logger.warn(`Reminders: found ${numExpired} expired, but couldn't splice because reminder at index ${i} was bad:\n`, reminders, '\n', reminders[i]);
        }
    }
}

/**
 * Serialize the reminders object to the given path, defaulting to the value of 'reminder_filename'
 *
 * @param {string} [path] The path to a file to write JSON data to. Default is the 'reminder_filename'.
 * @returns {Promise <boolean>} Whether the save operation completed without error.
 */
function saveReminders(path = reminder_filename) {
    // Write out the JSON of the reminders array
    return saveDataAsJSON(path, reminders).then(didSave => {
        Logger.log(`Reminders: ${didSave ? 'Saved' : 'Failed to save'} ${reminders.length} to '${path}'.`);
        last_timestamps.reminder_save = DateTime.utc();
        return didSave;
    });
}

/**
 * Instruct the given timer to send its announcement to all channels it is instructed to send to.
 *
 * @param {Timer} timer The timer being announced.
 */
function doAnnounce(timer) {
    if (!timer)
        return;
    const config = timer_config.get(timer.id);
    if (!config || !config.active)
        return;
    if (!config.channels.length)
        config.active = false;

    const message = timer.getAnnouncement();
    config.channels.forEach(tc => {
        if (tc.guild.available)
            tc.send(message).catch(err => {
                Logger.error(`(${timer.name}): Error during announcement on channel "${tc.name}" in "${tc.guild.name}".\nClient status: ${client.status}\n`, err);
                // Deactivate this channel only if we are connected to Discord. (Status === 'READY')
                // TODO: actually use the enum instead of a value for the enum (in case it changes):
                // https://github.com/discordjs/discord.js/blob/de0cacdf3209c4cc33b537ca54cd0969d57da3ab/src/util/Constants.js#L258
                if (client.status === 0) {
                    const index = config.channels.indexOf(tc);
                    Array.prototype.push.apply(config.inactiveChannels, config.channels.splice(index, 1));
                    Logger.warn(`(${timer.name}): deactivated announcement on channel ${tc.name} in ${tc.guild.name} due to send error during send.`);
                }
            });
    });
}

/**
 * Locate any known reminders that reference this timer, and send a PM to
 * the chatter who requested it.
 *
 * @param {Timer} timer The activated timer.
 */
function doRemind(timer) {
    if (!timer) return;

    // Cache these values.
    const area = timer.getArea(),
        sub = timer.getSubArea();

    // TODO: Build a basic embed template object and package that to each recipient, rather than
    // fully construct the (basically equivalent) embed for each user.
    const toDispatch = reminders
        // If there no sub-area for this reminder, or the one specified matches
        // that of the timer, send the reminder.
        .filter(r => area === r.area && r.count !== 0 && (!r.sub_area || r.sub_area === sub))
        // The reminder is sent using whichever one has the fewest remaining reminders.
        // For reminders with equivalent remaining quota, the more specific reminder is sent.
        .sort((a, b) => {
            if (a.count === b.count)
                // The two reminder quotas are equal: coerce the sub-areas from string -> bool -> int
                // and then return a descending sort (since true -> 1 and true means it was specific).
                return (!!b.sub_area) * 1 - (!!a.sub_area) * 1;

            // For dissimilar quotas, we know only one can be perpetual. If one is perpetual, sort descending.
            // Else, sort ascending.
            if (a.count === -1 || b.count === -1)
                return b.count - a.count;
            return a.count - b.count;
        });

    // Obtain a set of users who have not yet been notified from the sorted reminder array.
    const sent = new Set();
    // Dispatch the reminders, and update the set as we go.
    toDispatch.forEach(reminder => {
        const uid = reminder.user;
        if (!sent.has(uid)) {
            sent.add(uid);
            client.fetchUser(uid).then(user => sendRemind(user, reminder, timer))
                .catch(err => {
                    reminder.fail = (reminder.fail || 0) + 1;
                    Logger.error(`Reminders: Error during notification of user <@${uid}>:\n`, err);
                });
        }
    });
}

/**
 * Takes a user object and a reminder "object" and sends
 * the reminder as a RichEmbed via PM.
 * MAYBE: Add ReminderInfo class, let Timers ID one, and have timer definitions provide additional information
 *      to improve the appearance of the reminders.
 * @param {User} user The Discord user to be reminded
 * @param {TimerReminder} remind the user's specific data w.r.t. the Timer that activated
 * @param {Timer} timer the Timer that activated
 */
function sendRemind(user, remind, timer) {
    // Don't remind invalid users.
    if (!user) {
        remind.fail = (remind.fail || 0) + 1;
        return;
    }
    if (remind.count === 0)
        return;
    // TODO: better timer title info - no markdown formatting in the title.
    const output = new Discord.RichEmbed({ title: timer.getAnnouncement() });

    if (timer.getArea() === 'relic_hunter') {
        output.addField('Current Location', `She's in **${relic_hunter.location}**`, true);
        output.setTitle(`RH: ${relic_hunter.location}`);
    }

    // Describe the remaining reminders.
    if (remind.fail > 10)
        remind.count = 1;
    // For non-perpetual reminders, decrement the counter.
    output.addField('Reminders Left', (remind.count < 0) ? 'unlimited' : --remind.count, true);

    const advanceAmount = timer.getAdvanceNotice().as('milliseconds');
    // Should this be next user reminder, or next activation of this timer?
    output.addField('Next Reminder', (advanceAmount
        ? timer.getNext().plus(timer.getRepeatInterval()).minus(advanceAmount)
        : timer.getNext()
    ).diffNow().toFormat('dd\'d \'hh\'h \'mm\'m\'', { round: true }), true);

    // How to add or remove additional counts.
    let alter_str = `Use \`${settings.botPrefix} remind ${remind.area}${remind.sub_area ? ` ${remind.sub_area}` : ''}`;
    alter_str += (!remind.count) ? '` to turn this reminder back on.' : ' stop` to end these sooner.';
    alter_str += `\nUse \`${settings.botPrefix} help remind\` for additional info.`;
    output.addField('To Update:', alter_str, false);


    if (remind.fail) {
        output.setDescription(`(There were ${remind.fail} failures before this got through.)`);
        if (remind.fail > 10)
            Logger.warn(`Reminders: Removing reminder for ${remind.user} due to too many failures`);
    }

    // The timestamp could be the activation time, not the notification time. If there is
    // advance notice, then the activation time is yet to come (vs. moments ago).
    output.setTimestamp(new Date());
    output.setFooter('Sent:');

    user.send({ embed: output }).then(
        () => remind.fail = 0,
        () => remind.fail = (remind.fail || 0) + 1,
    );
}

/**
 * Add (or remove) a reminder.
 *
 * @param {ReminderRequest} timerRequest a timer request which has already passed through token
 *                                       validation to set 'area' and 'sub_area' as possible.
 * @param {Message} message the Discord message that initiated this request.
 */
function addRemind(timerRequest, message) {
    // If there were no area, the reminders would have been
    // listed instead of 'addRemind' being called.
    const area = timerRequest.area;
    const subArea = timerRequest.sub_area;
    if (!area) {
        message.channel.send('I do not know the area you asked for');
        return;
    }

    // Default to reminding the user once.
    const count = timerRequest.count || (timerRequest.count === 0 ? 0 : 1);
    const requestName = `${area}${subArea ? `: ${subArea}` : ''}`;

    // Delete the reminder, if that is being requested.
    // (Rather than try to modify the positions and number of elements in
    // reminders e.g. thread race saveReminders, simply set the count to 0.)
    if (!count) {
        const responses = [];
        for (const reminder of reminders)
            if (reminder.user === message.author.id && reminder.area === area) {
                if (subArea && subArea === reminder.sub_area) {
                    reminder.count = 0;
                    responses.push(`Reminder for '${requestName}' turned off.`);
                }
                else if (!subArea && !reminder.sub_area) {
                    reminder.count = 0;
                    responses.push(`Reminder for '${requestName}' turned off.`);
                }
            }

        message.author.send(responses.length
            ? `\`\`\`${responses.join('\n')}\`\`\``
            : `I couldn't find a matching reminder for you in '${requestName}'.`,
        );
        return;
    }

    // User asked to be reminded - find a timer that meets the request, and sort in order of next activation.
    const choices = timers_list
        .filter(t => area === t.getArea() && (!subArea || subArea === t.getSubArea()))
        .sort((a, b) => a.getNext() - b.getNext());
    Logger.log(`Timers: found ${choices.length} matching input request:\n`, timerRequest);

    // Assume the desired timer is the one that matched the given criteria and occurs next.
    const [timer] = choices;
    if (!timer) {
        message.author.send(`I'm sorry, there weren't any timers I know of that match your request. I know\n${getKnownTimersDetails()}`);
        return;
    }

    // If the reminder already exists, set its new count to the requested count.
    const responses = [];
    for (const reminder of reminders)
        if (reminder.user === message.author.id && reminder.area === area)
            if ((subArea && reminder.sub_area === subArea)
                || (!subArea && !reminder.sub_area))
            {
                responses.push(`Updated reminder count for '${requestName}' from '${reminder.count === -1
                    ? 'always' : reminder.count}' to '${count === -1 ? 'always' : count}'.`);
                reminder.count = count;
            }

    if (responses.length) {
        Logger.log(`Reminders: updated ${responses.length} for ${message.author.username} to a count of ${count}.`, timerRequest);
        message.author.send(`\`\`\`${responses.join('\n')}\`\`\``);
        return;
    }

    // No updates were made - free to add a new reminder.
    const newReminder = {
        'count': count,
        'area': area,
        'user': message.author.id,
    };
    // If the matched timer has a sub-area, we need to care about the sub-area specified
    // in the request. It will either be the same as that of this timer, or it will be
    // null / undefined (i.e. a request for reminders from all timers in the area).
    if (timer.getSubArea())
        newReminder.sub_area = subArea;
    reminders.push(newReminder);

    // If the user entered a generic reminder, they may not expect the specific name. Generic reminder
    // requests will have matched more than one timer, so we can reference 'choices' to determine the
    // proper response.
    const isGenericRequest = !subArea && timer.getSubArea();
    const subAreas = new Set(choices.map(t => `**${t.getSubArea()}**`));
    responses.push(`Your reminder for **${isGenericRequest ? area : timer.name}** is set. ${choices.length > 1
        ? `You'll get reminders for ${oxfordStringifyValues(subAreas)}. I'll PM you about them`
        : 'I\'ll PM you about it'}`);
    responses.push((count === 1) ? 'once.' : (count < 0) ? 'until you stop it.' : `${count} times.`);

    // Inform a new user of the reminder functionality (i.e. PM only).
    if (message.channel.type !== 'dm' && !reminders.some(r => r.user === message.author.id))
        responses.unshift('Hi there! Reminders are only sent via PM, and I\'m just making sure I can PM you.');

    // Send notice of the update via PM.
    message.author.send(responses.join(' ')).catch(() =>
        Logger.error(`Reminders: notification failure for ${message.author.username}.`),
    );
}

/**
 * List the reminders for the user, and PM them the result.
 *
 * @param {Message} message a Discord message containing the request to list reminders.
 */
function listRemind(message) {
    const user = message.author.id,
        pm_channel = message.author;
    let timer_str = 'Your reminders:';
    let usage_str;

    const userReminders = reminders.filter(r => r.user === user && r.count);
    userReminders.forEach(reminder => {
        // TODO: prettyPrint this info.
        const name = `${reminder.area}${reminder.sub_area ? ` (${reminder.sub_area})` : ''}`;
        timer_str += `\nTimer:\t**${name}**`;
        usage_str = `\`${settings.botPrefix} remind ${reminder.area}`;
        if (reminder.sub_area)
            usage_str += ` ${reminder.sub_area}`;

        timer_str += '\t';
        if (reminder.count === 1)
            timer_str += ' one more time';
        else if (reminder.count === -1)
            timer_str += ' until you stop it';
        else
            timer_str += ` ${reminder.count} times`;

        timer_str += `.\nTo turn off\t${usage_str} stop\`\n`;

        if (reminder.fail)
            timer_str += `There have been ${reminder.fail} failed attempts to activate this reminder.\n`;
    });

    pm_channel.send(userReminders.length ? timer_str : 'I found no reminders for you, sorry.')
        .catch(() => Logger.error(`Reminders: notification failure for ${pm_channel.username}. Possibly blocked.`));
}

/**
 * Compute which timers are coming up in the next bit of time, for the requested area.
 * Returns a ready-to-print string listing up to 24 of the found timers, with their "demand" and when they will activate.
 * TODO: should this return a RichEmbed?
 *
 * @param {{area: string, count: number}} timer_request A request that indicates the number of hours to search ahead, and the area in which to search
 * @returns {string} a ready-to-print string containing the timer's demand, and how soon it will occur.
 */
function buildSchedule(timer_request) {
    const area = timer_request.area;

    // Search from 1 hour to 10 days out.
    let req_hours = Duration.fromObject({ hours: timer_request.count });
    if (!req_hours.isValid) {
        return 'Invalid timespan given - how many hours did you want to look ahead?';
    }
    else if (req_hours.as('hours') <= 0)
        req_hours = req_hours.set({ hours: 24 });
    else if (req_hours.as('days') >= 10)
        req_hours = req_hours.shiftTo('days').set({ days: 10 });

    // Get the next occurrence for every timer. Compare its interval to determine how many of them to include
    const until = DateTime.utc().plus(req_hours);
    /** @type {{time: DateTime, message: string}[]} */
    const upcoming_timers = [];
    const max_timers = 24;
    (!area ? timers_list : timers_list.filter(t => t.getArea() === area && !t.isSilent()))
        .forEach(timer => {
            const message = timer.getDemand();
            for (const time of timer.upcoming(until))
                upcoming_timers.push({ time: time, message: message });
        });

    // Sort the list of upcoming timers in this area by time, so that the soonest is printed first.
    upcoming_timers.sort((a, b) => a.time - b.time);

    // Make a nice message to display.
    let return_str = `I have ${upcoming_timers.length} timers coming up in the next ${req_hours.as('hours')} hours`;
    if (upcoming_timers.length > max_timers) {
        return_str += `. Here are the next ${max_timers} of them`;
        upcoming_timers.splice(max_timers, upcoming_timers.length);
    }
    return_str += upcoming_timers.length ? ':\n' : '.';

    return_str = upcoming_timers.reduce((str, val) => {
        return `${str}${val.message} ${timeLeft(val.time)}\n`;
    }, return_str);

    return return_str;
}

/**
 * Get the help text.
 * TODO: Should this be a RichEmbed?
 * TODO: Dynamically generate this information based on timers, etc.
 *
 * @param {string[]} [tokens] An array of user text, the first of which is the specific command to get help for.
 * @returns {string} The desired help text.
 */
function getHelpMessage(tokens) {
    // TODO: dynamic help text - iterate known keyword commands and their arguments.
    const keywords = '`iam`, `whois`, `remind`, `next`, `find`, `ifind`, and `schedule`';
    const prefix = settings.botPrefix;
    if (!tokens || !tokens.length) {
        return [
            '**help**',
            `I know the keywords ${keywords}.`,
            `You can use \`${prefix} help <keyword>\` to get specific information about how to use it.`,
            `Example: \`${prefix} help next\` provides help about the 'next' keyword, \`${prefix} help remind\` provides help about the 'remind' keyword.`,
            'Pro Tip: **All commands work in PM!**',
        ].join('\n');
    }

    const areaInfo = 'Areas are Seasonal Garden (**sg**), Forbidden Grove (**fg**), Toxic Spill (**ts**), Balack\'s Cove (**cove**), and the daily **reset**.';
    const subAreaInfo = 'Sub areas are the seasons, open/close, spill ranks, and tide levels';
    const privacyWarning = '\nSetting your location and rank means that when people search for those things, you can be randomly added to the results.';
    const dbFilters = filters.reduce((acc, filter) => `${acc}\`${filter.code_name}\`, `, '') + 'and `current`';

    if (tokens[0] === 'next') {
        return [
            '**next**',
            `Usage: \`${prefix} next [<area> | <sub-area>]\` will provide a message about the next related occurrence.`,
            areaInfo,
            subAreaInfo,
            `Example: \`${prefix} next fall\` will tell when it is Autumn in the Seasonal Garden.`,
        ].join('\n');
    }
    else if (tokens[0] === 'remind') {
        return [
            '**remind**',
            `Usage: \`${prefix} remind [<area> | <sub-area>] [<number> | always | stop]\` will control my reminder function relating to you specifically.`,
            'Using the word `stop` will turn off a reminder if it exists.',
            'Using a number means I will remind you that many times for that timer.',
            'Use the word `always` to have me remind you for every occurrence.',
            `Just using \`${prefix} remind\` will list all your existing reminders and how to turn off each`,
            areaInfo,
            subAreaInfo,
            `Example: \`${prefix} remind close always\` will always PM you 15 minutes before the Forbidden Grove closes.`,
        ].join('\n');
    }
    else if (tokens[0].substring(0, 5) === 'sched') {
        return [
            '**schedule**',
            `Usage: \`${prefix} schedule [<area>] [<number>]\` will tell you the timers scheduled for the next \`<number>\` of hours. Default is 24, max is 240.`,
            'If you provide an area, I will only report on that area.',
            areaInfo,
        ].join('\n');
    }
    else if (tokens[0] === 'find') {
        return [
            '**find**',
            `Usage \`${prefix} find [-e <filter>] <mouse>\` will print the top attractions for the mouse, capped at 10.`,
            `Use of \`-e <filter>\` is optional and adds a time filter. Known filters are: ${dbFilters}`,
            'All attraction data is from <https://mhhunthelper.agiletravels.com/>.',
            'Help populate the database for better information!',
        ].join('\n');
    }
    else if (tokens[0] === 'ifind') {
        return [
            '**ifind**',
            `Usage \`${prefix} ifind [-e <filter>] <item>\` will print the top 10 drop rates (per catch) for the item.`,
            `Use of \`-e <filter>\` is optional and adds a time filter. Known filters are: ${dbFilters}`,
            'All drop rate data is from <https://mhhunthelper.agiletravels.com/>.',
            'Help populate the database for better information!',
        ].join('\n');
    }
    else if (tokens[0] === 'iam') {
        return [
            '**iam**',
            `Usage \`${prefix} iam <####>\` will set your hunter ID. **This must be done before the other options will work.**`,
            `  \`${prefix} iam in <location>\` will set your hunting location. Nicknames are allowed.`,
            `  \`${prefix} iam rank <rank>\` will set your rank. Nicknames are allowed.`,
            `  \`${prefix} iam not\` will remove you from results.`,
            privacyWarning,
        ].join('\n');
    }
    else if (tokens[0] === 'whois') {
        return [
            '**whois**',
            `Usage \`${prefix} whois <####>\` will try to look up a Discord user by MH ID. Only works if they set their ID.`,
            `  \`${prefix} whois <user>\` will try to look up a hunter ID based on a user in the server.`,
            `  \`${prefix} whois in <location>\` will find up to 5 random hunters in that location.`,
            `  \`${prefix} whois rank <rank>\` will find up to 5 random hunters with that rank.`,
            privacyWarning,
        ].join('\n');
    }
    else
        return `I don't know that one, but I do know ${keywords}.`;
}

/**
 * @typedef {Object} DatabaseEntity
 * @property {string} id The ID of the entity
 * @property {string} value The entity's proper name
 * @property {string} lowerValue A lowercased version of the entity's name
 */

/**
 * Query @devjacksmith's database for information about the given "item"
 *
 * @param {'loot'|'mouse'} queryType The type of "item" whose data is requested.
 * @param {DatabaseEntity} dbEntity Identifying information about the "item"
 * @param {Object <string, string>} [options] Any additional querystring options that should be set
 * @returns {Promise <any>} Result of the query to @devjacksmiths database
 */
function getQueriedData(queryType, dbEntity, options) {
    // TODO: fetch each value once, cache, and try to first serve cached content.
    if (!dbEntity || !dbEntity.id || !dbEntity.value)
        return Promise.reject({ error: `Could not perform a '${queryType}' query`, response: null });
    // Check cache
    /**
     * Replace with actual cache checking:
     * let cache_result = Cache.get(queryType, dbEntity.id, options)
     * if (cache_result)
     *   return Promise.resolve(cache_result);
     */

    // No result in cache, requery.
    const qsOptions = new URLSearchParams(options);
    qsOptions.append('item_type', queryType);
    qsOptions.append('item_id', dbEntity.id);

    return fetch('https://mhhunthelper.agiletravels.com/searchByItem.php?' + qsOptions.toString())
        .then((response) => {
            if (response.ok) {
                /**
                 * Replace with actual cache storage:
                 * Cache.put(queryType, dbEntity.id, options, body);
                 */
                return response.json();
            } else {
                throw { error: `HTTP ${response.status}`, response };
            }
        });
}

/**
 * Process args for flags, like the -e event filter. Returns the args without any processed flags.
 *
 * @param {string} args a lowercased string of search criteria that may contain flags that map to querystring parameters
 * @param {Object <string, string>} qsParams an object which will have any discovered querystring parameters added
 * @returns {string} args, after stripping out any tokens associated with querystring parameters.
 */
function removeQueryStringParams(args, qsParams) {
    const tokens = args.split(/\s+/);
    if (tokens.length > 2) {
        if (tokens[0] === '-e') {
            // Allow shorthand specifications instead of only the literal `last3days`.
            // TODO: discover valid shorthands on startup.
            // TODO: parse flag and argument even if given after the query.
            switch (tokens[1].toLowerCase()) {
                case '3':
                case '3d':
                    tokens[1] = '3_days';
                    break;
                case 'current':
                    // Default to last 3 days, but if there is an ongoing event, use that instead.
                    tokens[1] = '1_month';
                    for (const filter of filters) {
                        if (filter.start_time && !filter.end_time && filter.code_name !== tokens[1]) {
                            tokens[1] = filter.code_name;
                            break;
                        }
                    }
                    break;
            }
            qsParams.timefilter = tokens[1].toString();
            tokens.splice(0, 2);
        }
        // TODO: other querystring params (once supported).
        args = tokens.join(' ');
    }
    return args;
}

/**
 * Initialize (or refresh) the known mice lists from @devjacksmith's tools.
 * @returns {Promise<void>}
 */
function getMouseList() {
    const now = DateTime.utc();
    // Only request a mouse list update every so often.
    if (last_timestamps.mouse_refresh) {
        const next_refresh = last_timestamps.mouse_refresh.plus(refresh_rate);
        if (now < next_refresh)
            return Promise.resolve();
    }
    last_timestamps.mouse_refresh = now;

    // Query @devjacksmith's tools for mouse lists.
    Logger.log('Mice: Requesting a new mouse list.');
    const url = 'https://mhhunthelper.agiletravels.com/searchByItem.php?item_type=mouse&item_id=all';
    return fetch(url).then(response => (response.status === 200) ? response.json() : '').then((body) => {
        if (body) {
            Logger.log('Mice: Got a new mouse list.');
            mice.length = 0;
            Array.prototype.push.apply(mice, body);
            mice.forEach(mouse => mouse.lowerValue = mouse.value.toLowerCase());
        } else {
            Logger.warn('Mice: request returned non-200 response');
        }
    }).catch(err => Logger.error('Mice: request returned error:', err));
}

/**
 * Check the input args for a known mouse that can be looked up.
 * If no result is found, retries with an item search.
 *
 * @param {TextChannel} channel the channel on which to respond.
 * @param {string} args a lowercased string of search criteria.
 * @param {string} command the command switch used to initiate the request.
 */
function findMouse(channel, args, command) {
    /**
     * Request the latest information about the valid mouse.
     * @param {boolean} canSpam Whether the long or short response should be sent back.
     * @param {DatabaseEntity} mouse The valid mouse to query for
     * @param {Object <string, string>} opts Additional querystring parameters for the request, like 'timefilter'
     * @returns {Promise<string>} The result of the lookup.
     */
    function _getQueryResult(canSpam, mouse, opts) {
        return getQueriedData('mouse', mouse, opts).then(body => {
            // Querying succeeded. Received a JSON object (either from cache or HTTP lookup).
            // body is an array of objects with: location, stage, total_hunts, rate, cheese
            // Sort it by "rate" but only if hunts > 100
            const attractions = body.filter(setup => setup.total_hunts > 99)
                .map(setup => {
                    return {
                        location: setup.location,
                        stage: setup.stage ? setup.stage : ' N/A ',
                        total_hunts: integerComma(setup.total_hunts),
                        rate: setup.rate * 1.0 / 100,
                        cheese: setup.cheese,
                    };
                });
            if (!attractions.length)
                return `${mouse.value} either hasn't been seen enough, or something broke.`;

            // Sort that by Attraction Rate, descending.
            attractions.sort((a, b) => b.rate - a.rate);
            // Keep only the top 10 results, unless this is a DM.
            attractions.splice(!canSpam ? 10 : 100);

            // Column Formatting specification.
            /** @type {Object <string, ColumnFormatOptions>} */
            const columnFormatting = {};

            // Specify the column order.
            const order = ['location', 'stage', 'cheese', 'rate', 'total_hunts'];
            // Inspect the attractions array to determine if we need to include the stage column.
            if (attractions.every(row => row.stage === ' N/A '))
                order.splice(order.indexOf('stage'), 1);

            // Build the header row.
            const labels = { location: 'Location', stage: 'Stage', total_hunts: 'Hunts', rate: 'AR', cheese: 'Cheese' };
            const headers = order.map(key => {
                columnFormatting[key] = {
                    columnWidth: labels[key].length,
                    alignRight: !isNaN(parseInt(attractions[0][key], 10)),
                };
                return { 'key': key, 'label': labels[key] };
            });

            // Give the numeric column proper formatting.
            // TODO: toLocaleString - can it replace integerComma too?
            columnFormatting['rate'] = {
                alignRight: true,
                isFixedWidth: true,
                columnWidth: 7,
                suffix: '%',
            };

            let retStr = `${mouse.value} (mouse) can be found the following ways:\n\`\`\``;
            retStr += prettyPrintArrayAsString(attractions, columnFormatting, headers, '=');
            retStr += `\`\`\`\nHTML version at: <https://mhhunthelper.agiletravels.com/?mouse=${mouse.id}&timefilter=${opts.timefilter ? opts.timefilter : 'all_time'}>`;
            return retStr;
        }, reason => {
            // Querying failed. Received an error object / string, and possibly a response object.
            Logger.error('Mice: Lookup failed for some reason:\n', reason.error, reason.response ? reason.response.toJSON() : 'No HTTP response');
            throw new Error(`Could not process results for '${args}', AKA ${mouse.value}`);
        });
    }


    const isDM = ['dm', 'group'].includes(channel.type);
    const urlInfo = {
        qsParams: {},
        uri: 'https://mhhunthelper.agiletravels.com/',
        type: 'mouse',
    };

    // Deep copy the input args, in case we modify them.
    const orig_args = JSON.parse(JSON.stringify(args));
    args = removeQueryStringParams(args, urlInfo.qsParams);

    // If the input was a nickname, convert it to the queryable value.
    if (nicknames.get('mice')[args])
        args = nicknames.get('mice')[args];

    // Special case of the relic hunter RGW
    if (args.toLowerCase() === 'relic hunter') {
        findRH(channel);
        return;
    }

    const matches = getSearchedEntity(args, mice);
    if (!matches.length) {
        // If this was a mouse search, try finding an item.
        if (command === 'find')
            findItem(channel, orig_args, command);
        else {
            channel.send(`'${orig_args}' not found.`);
            getItemList();
        }
    }
    else
        sendInteractiveSearchResult(matches, channel, _getQueryResult, isDM, urlInfo, args);
}

/**
 * Initialize (or refresh) the known loot lists from @devjacksmith's tools.
 * @returns {Promise<void>}
 */
function getItemList() {
    const now = DateTime.utc();
    if (last_timestamps.item_refresh) {
        const next_refresh = last_timestamps.item_refresh.plus(refresh_rate);
        if (now < next_refresh)
            return Promise.resolve();
    }
    last_timestamps.item_refresh = now;

    Logger.log('Loot: Requesting a new loot list.');
    const url = 'https://mhhunthelper.agiletravels.com/searchByItem.php?item_type=loot&item_id=all';
    return fetch(url).then(response => (response.status === 200) ? response.json() : '').then((body) => {
        if (body) {
            Logger.log('Loot: Got a new loot list.');
            items.length = 0;
            Array.prototype.push.apply(items, body);
            items.forEach(item => item.lowerValue = item.value.toLowerCase());
        } else {
            Logger.warn('Loot: request returned non-200 response');
        }
    }).catch(err => Logger.error('Mice: request returned error:', err));
}

/**
 * Initialize (or refresh) the known filters from @devjacksmith's tools.
 * @returns {Promise<void>}
 */
function getFilterList() {
    const now = DateTime.utc();
    if (last_timestamps.filter_refresh) {
        const next_refresh = last_timestamps.filter_refresh.plus(refresh_rate);
        if (now < next_refresh)
            return Promise.resolve();
    }
    last_timestamps.filter_refresh = now;

    Logger.log('Filters: Requesting a new filter list.');
    const url = 'https://mhhunthelper.agiletravels.com/filters.php';
    return fetch(url).then(response => (response.status === 200) ? response.json() : '').then((body) => {
        if (body) {
            Logger.log('Filters: Got a new filter list');
            filters.length = 0;
            Array.prototype.push.apply(filters, body);
            filters.forEach(filter => filter.lowerValue = filter.code_name.toLowerCase());
        } else {
            Logger.warn('Filters: request returned non-200 response');
        }
    }).catch(err => Logger.error('Filters: request returned error:', err));
}

/**
 * Check the input args for a known item that can be looked up.
 * If no result is found, retries with a mouse search.
 *
 * @param {TextChannel} channel the channel on which to respond.
 * @param {string} args a lowercased string of search criteria.
 * @param {string} command the command switch used to initiate the request.
 */
function findItem(channel, args, command) {
    /**
     * Request the latest information about the valid item.
     * @param {boolean} canSpam Whether the long or short response should be sent back.
     * @param {DatabaseEntity} item The valid item to query for
     * @param {Object <string, string>} opts Additional querystring parameters for the request, like 'timefilter'
     * @returns {Promise<string>} The result of the lookup.
     */
    function _getQueryResult(canSpam, item, opts) {
        return getQueriedData('loot', item, opts).then(body => {
            // Querying succeeded. Received a JSON object (either from cache or HTTP lookup).
            // body is an array of objects with: location, stage, total_hunts, rate, cheese
            // 2018-06-18 rate -> rate_per_catch; total_hunts -> total_catches
            // Sort by "rate" but only if hunts >= 100
            const attractions = body.filter(setup => setup.total_catches > 99)
                .map(setup => {
                    return {
                        location: setup.location,
                        stage: setup.stage === null ? ' N/A ' : setup.stage,
                        total_hunts: integerComma(setup.total_catches),
                        rate: setup.rate_per_catch * 1.0 / 1000, // Divide by 1000? should this be 100?
                        cheese: setup.cheese,
                    };
                });
            if (!attractions.length)
                return `${item.value} either hasn't been seen enough, or something broke.`;

            // Sort the setups by the drop rate.
            attractions.sort((a, b) => b.rate - a.rate);
            // Keep only the top 10 results, unless this is a DM.
            attractions.splice(!canSpam ? 10 : 100);

            // Column Formatting specification.
            /** @type {Object <string, ColumnFormatOptions>} */
            const columnFormatting = {};

            // Specify the column order.
            const order = ['location', 'stage', 'cheese', 'rate', 'total_hunts'];
            // Inspect the setups array to determine if we need to include the stage column.
            if (attractions.every(row => row.stage === ' N/A '))
                order.splice(order.indexOf('stage'), 1);

            // Build the header row.
            const labels = { location: 'Location', stage: 'Stage', total_hunts: 'Catches', rate: 'DR', cheese: 'Cheese' };
            const headers = order.map(key => {
                columnFormatting[key] = {
                    columnWidth: labels[key].length,
                    alignRight: !isNaN(parseInt(attractions[0][key], 10)),
                };
                return { 'key': key, 'label': labels[key] };
            });

            // Give the numeric column proper formatting.
            columnFormatting['rate'] = {
                alignRight: true,
                isFixedWidth: true,
                numDecimals: 3,
                columnWidth: 7,
            };

            let retStr = `${item.value} (loot) can be found the following ways:\n\`\`\``;
            retStr += prettyPrintArrayAsString(attractions, columnFormatting, headers, '=');
            retStr += `\`\`\`\nHTML version at: <https://mhhunthelper.agiletravels.com/loot.php?item=${item.id}&timefilter=${opts.timefilter ? opts.timefilter : 'all_time'}>`;
            return retStr;
        }, reason => {
            // Querying failed. Received an error object / string, and possibly a response object.
            Logger.error('Loot: Lookup failed for some reason:\n', reason.error, reason.response ? reason.response.toJSON() : 'No HTTP response');
            throw new Error(`Could not process results for '${args}', AKA ${item.value}`);
        });
    }


    const isDM = ['dm', 'group'].includes(channel.type);
    const urlInfo = {
        qsParams: {},
        uri: 'https://mhhunthelper.agiletravels.com/loot.php',
        type: 'item',
    };

    // Deep copy the input args, in case we modify them.
    const orig_args = JSON.parse(JSON.stringify(args));
    args = removeQueryStringParams(args, urlInfo.qsParams);

    // If the input was a nickname, convert it to the queryable value.
    if (nicknames.get('loot')[args])
        args = nicknames.get('loot')[args];

    const matches = getSearchedEntity(args, items);
    if (!matches.length) {
        // If this was an item search, try finding a mouse.
        if (command === 'ifind')
            findMouse(channel, orig_args, command);
        else {
            channel.send(`'${orig_args}' not found.`);
            getMouseList();
        }
    }
    else
        sendInteractiveSearchResult(matches, channel, _getQueryResult, isDM, urlInfo, args);
}

/**
 * Construct and dispatch a reaction-enabled message for interactive "search result" display.
 *
 * @param {DatabaseEntity[]} searchResults An ordered array of objects that resulted from a search.
 * @param {TextChannel} channel The channel on which the client received the find request.
 * @param {Function} dataCallback a Promise-returning function that converts the local entity data into the desired text response.
 * @param {boolean} isDM Whether the response will be to a private message (i.e. if the response can be spammy).
 * @param {{qsParams: Object <string, string>, uri: string, type: string}} urlInfo Information about the query that returned the given matches, including querystring parameters, uri, and the type of search.
 * @param {string} searchInput a lower-cased representation of the user's input.
 */
function sendInteractiveSearchResult(searchResults, channel, dataCallback, isDM, urlInfo, searchInput) {
    // Associate each search result with a "numeric" emoji.
    const matches = searchResults.map((sr, i) => ({ emojiId: emojis[i].id, match: sr }));
    // Construct a RichEmbed with the search result information, unless this is for a PM with a single response.
    const embed = new Discord.RichEmbed({
        title: `Search Results for '${searchInput}'`,
        thumbnail: { url: 'https://cdn.discordapp.com/emojis/359244526688141312.png' }, // :clue:
        footer: { text: `For any reaction you select, I'll ${isDM ? 'send' : 'PM'} you that information.` },
    });

    // Precompute the url prefix & suffix for each search result. Assumption: single-valued querystring params.
    const urlPrefix = `${urlInfo.uri}?${urlInfo.type}=`;
    const urlSuffix = Object.keys(urlInfo.qsParams).reduce((acc, key) => `${acc}&${key}=${urlInfo.qsParams[key]}`, '');
    // Generate the description to include the reaction, name, and link to HTML data on @devjacksmith's website.
    const description = matches.reduce((acc, entity, i) => {
        const url = `${urlPrefix}${entity.match.id}${urlSuffix}`;
        const row = `\n\t${emojis[i].text}:\t[${entity.match.value}](${url})`;
        return acc + row;
    }, `I found ${matches.length === 1 ? 'a single result' : `${matches.length} good results`}:`);
    embed.setDescription(description);

    const searchResponse = (isDM && matches.length === 1)
        ? `I found a single result for '${searchInput}':`
        : embed;
    const sent = channel.send(searchResponse);
    // To ensure a sensible order of emojis, we have to await the previous react's resolution.
    if (!isDM || matches.length > 1)
        sent.then(async (msg) => {
            /** @type MessageReaction[] */
            const mrxns = [];
            for (const m of matches)
                mrxns.push(await msg.react(m.emojiId).catch(err => Logger.error(err)));
            return mrxns;
        }).then(msgRxns => {
            // Set a 5-minute listener on the message for these reactions.
            const msg = msgRxns[0].message,
                allowed = msgRxns.map(mr => mr.emoji.name),
                filter = (reaction, user) => allowed.includes(reaction.emoji.name) && !user.bot,
                rc = msg.createReactionCollector(filter, { time: 5 * 60 * 1000 });
            rc.on('collect', mr => {
                // Fetch the response and send it to the user.
                const match = matches.filter(m => m.emojiId === mr.emoji.identifier)[0];
                if (match) dataCallback(true, match.match, urlInfo.qsParams).then(
                    result => mr.users.last().send(result, { split: { prepend: '```', append: '```' } }),
                    result => mr.users.last().send(result),
                ).catch(err => Logger.error(err));
            }).on('end', () => rc.message.clearReactions().catch(() => rc.message.delete()));
        }).catch(err => Logger.error('Reactions: error setting reactions:\n', err));

    // Always send one result to the channel.
    sent.then(() => dataCallback(isDM, matches[0].match, urlInfo.qsParams).then(
        result => channel.send(result, { split: { prepend: '```', append: '```' } }),
        result => channel.send(result)),
    ).catch(err => Logger.error(err));
}

/**
 * Return a sorted list of approximate matches to the given input and container
 *
 * @param {string} input The text to match against
 * @param {DatabaseEntity[]} values The known values.
 * @returns {Array <number>[]} Up to 10 indices and their search score.
 */
function getSearchedEntity(input, values) {
    if (!input.length || !Array.isArray(values) || !values.length)
        return [];

    const matches = values.filter(v => v.lowerValue.includes(input)).map(v => {
        return { entity: v, score: v.lowerValue.indexOf(input) };
    });
    matches.sort((a, b) => {
        const r = a.score - b.score;
        // Sort lexicographically if the scores are equal.
        return r ? r : a.entity.value.localeCompare(b.entity.value, { sensitivity: 'base' });
    });
    // Keep only the top 10 results.
    matches.splice(10);
    return matches.map(m => m.entity);
}



/**
 * Interrogate the local 'hunters' data object to find self-registered hunters that match the requested
 * criteria.
 *
 * @param {Message} message the Discord message that initiated this search
 * @param {string[]} searchValues an array of hids, snuids, or names/mentions to search for.
 * @param {string} type the method to use to find the member
 */
function findHunter(message, searchValues, type) {
    const noPM = ['hid', 'snuid', 'name'];
    if (!message.guild && noPM.indexOf(type) !== -1) {
        message.channel.send(`Searching by ${type} isn't allowed via PM.`);
        return;
    }

    let discordId;
    if (type === 'name') {
        // Use message text or mentions to obtain the discord ID.
        const member = message.mentions.members.first() || message.guild.members
            .filter(member => member.displayName.toLowerCase() === searchValues[0].toLowerCase()).first();
        if (member) {
            // Prevent mentioning this user in our reply.
            searchValues[0] = member.displayName;
            // Ensure only registered hunters get a link in our reply.
            if (getHunterByDiscordID(member.id))
                discordId = member.id;
        }
    } else if (searchValues[0]) {
        // This is self-volunteered information that is tracked.
        discordId = getHunterByID(searchValues[0], type);
    }
    if (!discordId) {
        message.channel.send(`I did not find a registered hunter with **${searchValues[0]}** as a ${type === 'hid' ? 'hunter ID' : type}.`,
            { disableEveryone: true });
        return;
    }
    // The Discord ID belongs to a registered member of this server.
    const link = `<https://mshnt.ca/p/${getHunterByDiscordID(discordId)}>`;
    client.fetchUser(discordId).then(user => message.guild.fetchMember(user))
        .then(member => message.channel.send(`**${searchValues[0]}** is ${member.displayName} ${link}`,
            { disableEveryone: true }))
        .catch(err => {
            Logger.error(err);
            message.channel.send('That person may not be on this server.');
        });
}

/**
 * Unsets the hunter's id (and all other friend-related settings), and messages the user back.
 * Currently all settings are friend-related.
 *
 * @param {Message} message A Discord message object
 */
function unsetHunterID(message) {
    const hunter = message.author.id;
    if (hunters[hunter]) {
        delete hunters[hunter];
        message.channel.send('*POOF*, you\'re gone!');
    } else {
        message.channel.send('I didn\'t do anything but that\'s because you didn\'t do anything either.');
    }
}

/**
 * Sets the message author's hunter ID to the passed argument, and messages the user back.
 *
 * @param {Message} message a Discord message object from a user
 * @param {string} hid a "Hunter ID" string, which is known to parse to a number.
 */
function setHunterID(message, hid) {
    const discordId = message.author.id;
    let message_str = '';

    // Initialize the data for any new registrants.
    if (!hunters[discordId]) {
        hunters[discordId] = {};
        Logger.log(`Hunters: OMG! A new hunter id '${discordId}'`);
    }

    // If they already registered a hunter ID, update it.
    if (hunters[discordId]['hid']) {
        message_str = `You used to be known as \`${hunters[discordId]['hid']}\`. `;
        Logger.log(`Hunters: Updating hid ${hunters[discordId]['hid']} to ${hid}`);
    }
    hunters[discordId]['hid'] = hid;
    message_str += `If people look you up they'll see \`${hid}\`.`;

    message.channel.send(message_str);
}

/**
 * Accepts a message object and hunter id, sets the author's hunter ID to the passed argument
 *
 * @param {Message} message a Discord message object
 * @param {string} property the property key for the given user, e.g. 'hid', 'rank', 'location'
 * @param {any} value the property's new value.
 */
function setHunterProperty(message, property, value) {
    const discordId = message.author.id;
    if (!hunters[discordId] || !hunters[discordId]['hid']) {
        message.channel.send('I don\'t know who you are so you can\'t set that now; set your hunter ID first.');
        return;
    }

    let message_str = !hunters[discordId][property] ? '' : `Your ${property} used to be \`${hunters[discordId][property]}\`. `;
    hunters[discordId][property] = value;

    message_str += `Your ${property} is set to \`${value}\``;
    message.channel.send(message_str);
}

/**
 * Load hunter data from the input path, defaulting to the value of 'hunter_ids_filename'.
 * Returns the hunter data contained in the given file.
 *
 * @param {string} [path] The path to a JSON file to read data from. Default is the 'hunter_ids_filename'.
 * @returns {Promise <{}>} Data from the given file, as an object to be consumed by the caller.
 */
function loadHunterData(path = hunter_ids_filename) {
    return loadDataFromJSON(path).catch(err => {
        Logger.error(`Hunters: Error loading data from '${path}':\n`, err);
        return {};
    });
}

/**
 * Serialize the hunters object to the given path, defaulting to the value of 'hunter_ids_filename'
 *
 * @param {string} [path] The path to a file to write JSON data to. Default is the 'hunter_ids_filename'.
 * @returns {Promise <boolean>} Whether the save operation completed without error.
 */
function saveHunters(path = hunter_ids_filename) {
    return saveDataAsJSON(path, hunters).then(didSave => {
        Logger.log(`Hunters: ${didSave ? 'Saved' : 'Failed to save'} ${Object.keys(hunters).length} to '${path}'.`);
        last_timestamps.hunter_save = DateTime.utc();
        return didSave;
    });
}

/**
 * Load nickname data from the input path, defaulting to the value of 'nickname_urls_filename'.
 * Returns the type: url data contained in the given file. (Does not assign it.)
 *
 * @param {string} [path] The path to a JSON file to read data from. Default is the 'nickname_urls_filename'.
 * @returns {Promise <{}>} Data from the given file, as an object to be consumed by the caller.
 */
function loadNicknameURLs(path = nickname_urls_filename) {
    return loadDataFromJSON(path).catch(err => {
        Logger.error(`Nicknames: Error loading data from '${path}':\n`, err);
        return {};
    });
}

/**
 * Load all nicknames from all sources.
 */
function refreshNicknameData() {
    for (const key in nickname_urls)
        getNicknames(key);
}

/**
 * Read the CSV exported from a Google Sheets file containing nicknames, and
 * initialize the specific 'nickname' property denoted by 'type'.
 *
 * // TODO use the Google Sheets REST API or an Apps Script webapp for
 * better control / formatting (e.g. JSON output, referencing sheets by name)
 *
 * @param {string} type The type of nickname to populate. Determines the sheet that is read.
 */
function getNicknames(type) {
    if (!nickname_urls[type]) {
        Logger.warn(`Nicknames: Received '${type}' but I don't know its URL.`);
        return;
    }
    const newData = {};
    // It returns a string as CSV, not JSON.
    // Set up the parser
    const parser = csv_parse({ delimiter: ',' })
        .on('readable', () => {
            let record;
            // eslint-disable-next-line no-cond-assign
            while (record = parser.read())
                newData[record[0]] = record[1];
        })
        .on('error', err => Logger.error(err.message));

    fetch(nickname_urls[type]).then(async (response) => {
        if (response.status !== 200) {
            throw new Error(`HTTP ${response.status}`);
        }
        const body = await response.text();
        // Pass the response to the CSV parser (after removing the header row).
        parser.write(body.split(/[\r\n]+/).splice(1).join('\n').toLowerCase());
        // Create a new (or replace the existing) nickname definition for this type.
        nicknames.set(type, newData);
        parser.end(() => Logger.log(`Nicknames: ${Object.keys(newData).length} of type '${type}' loaded.`));
    }).catch(err => Logger.error(`Nicknames: request for type '${type}' failed with error:`, err));
}

/**
 * Find the first Discord account for the user with the given input property.
 * Returns undefined if no registered user has the given property.
 *
 * @param {string} input The property value to attempt to match.
 * @param {string} type Any stored property type (typically fairly-unique ones such as 'snuid' or 'hid').
 * @returns {string?} The discord ID, or undefined if the hunter ID was not registered.
 */
function getHunterByID(input, type) {
    if (input)
        for (const key in hunters)
            if (hunters[key][type] === input)
                return key;
}

/**
 * Find the self-registered account for the user identified by the given Discord ID.
 * Returns undefined if the user has not self-registered.
 *
 * @param {string} discordId the Discord ID of a registered hunter.
 * @returns {string?} the hunter ID of the registered hunter having that Discord ID.
 */
function getHunterByDiscordID(discordId) {
    if (hunters[discordId])
        return hunters[discordId]['hid'];
}

/**
 * Find random hunter ids to befriend, based on the desired property and criterion.
 *
 * @param {string} property a hunter attribute, like "location" or "rank"
 * @param {string} criterion user-entered input.
 * @param {number} limit the maximum number of hunters to return.
 * @returns {string[]} an array of up to 5 hunter ids where the property value matched the user's criterion
 */
function getHuntersByProperty(property, criterion, limit = 5) {
    const valid = Object.keys(hunters)
        .filter(key => hunters[key][property] === criterion)
        .map(key => hunters[key].hid);

    return valid.sort(() => 0.5 - Math.random()).slice(0, limit);
}

/**
 * Convert the input number into a formatted string, e.g. 1234 -> 1,234
 * @param {number} number The number to be formatted
 * @returns {string} A comma-formatted string.
 */
function integerComma(number) {
    return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Reset the Relic Hunter location so reminders know to update people
 */
function resetRH() {
    Logger.log(`Relic hunter: resetting location to "unknown", was ${relic_hunter.source}: ${relic_hunter.location}`);
    relic_hunter.location = 'unknown';
    relic_hunter.source = 'reset';
    relic_hunter.last_seen = DateTime.fromMillis(0);
    // Schedule the next reset.
    rescheduleResetRH();
}

/**
 * Continue resetting Relic Hunter location
 */
function rescheduleResetRH() {
    if (relic_hunter.timeout)
        clearTimeout(relic_hunter.timeout);

    const now = DateTime.utc();
    relic_hunter.timeout = setTimeout(resetRH, Interval.fromDateTimes(now, now.endOf('day')).length('milliseconds'));
}

/**
 * Notify about relic hunter changing location
 */
function remindRH(new_location) {
    //Logic to look for people with the reminder goes here
    if (new_location != 'unknown') {
        Logger.log(`Relic Hunter: Sending reminders for ${new_location}`);
        doRemind(timers_list.find(t => t.getArea() === 'relic_hunter'));
    }
}

/**
 * Relic Hunter location was announced, save it and note the source
 * @param {Message} message Webhook-generated message announcing RH location
 */
function handleRHWebhook(message) {
    // Find the location in the text.
    const locationRE = /spotted in \*\*(.+)\*\*/;
    if (locationRE.test(message.cleanContent)) {
        const new_location = locationRE.exec(message.cleanContent)[1];
        if (relic_hunter.location !== new_location) {
            relic_hunter.location = new_location;
            relic_hunter.source = 'webhook';
            relic_hunter.last_seen = DateTime.utc();
            Logger.log(`Relic Hunter: Webhook set location to "${new_location}"`);
            setImmediate(remindRH, new_location);
        } else {
            Logger.log(`Relic Hunter: skipped location update (already set by ${relic_hunter.source})`);
        }
    } else {
        Logger.error('Relic Hunter: failed to extract location from webhook message:', message.cleanContent);
    }
}

/**
 * Especially at startup, find the relic hunter's location
 * TODO: This might replace the reset function
 */
async function getRHLocation() {
    Logger.log(`Relic Hunter: Was in ${relic_hunter.location} according to ${relic_hunter.source}`);
    const [dbg, mhct] = await Promise.all([
        DBGamesRHLookup(),
        MHCTRHLookup(),
    ]);
    // Trust MHCT more, since it would actually observe an RH appearance, rather than decode a hint.
    if (mhct.location !== 'unknown') {
        Object.assign(relic_hunter, mhct);
    } else if (dbg.location !== 'unknown') {
        Object.assign(relic_hunter, dbg);
    } else {
        // Both sources returned unknown.
        resetRH();
    }
    Logger.log(`Relic Hunter: location set to "${relic_hunter.location}" with source "${relic_hunter.source}"`);
}

/**
 * Looks up Relic Hunter Location from DBGames via Google Sheets
 * @returns {Promise<{ location: string, source: 'DBGames' }>}
 */
function DBGamesRHLookup() {
    return fetch('https://docs.google.com/spreadsheets/d/e/2PACX-1vSsqAjocBWcN5dDLXuOBfnBhyrTaO7ZeIEAFlDnQ4r6zqcvtuLKMDBQCh5I8-3M9irS4-17OPfvgKtY/pub?gid=1975888453&single=true&output=csv')
        .then(async (response) => {
            if (!response.ok) throw `HTTP ${response.status}`;
            const location = await response.text();
            Logger.log('Relic Hunter: DBGames query OK, reported location:', location);
            return { source: 'DBGames', location, last_seen: DateTime.utc().startOf('day') };
        })
        .catch((err) => {
            Logger.error('Relic Hunter: DBGames query failed:', err);
            return { source: 'DBGames', location: 'unknown' };
        });
}

/**
 * Looks up the relic hunter location from MHCT
 * @returns {Promise<{ location: string, source: 'MHCT' }>}
 */
function MHCTRHLookup() {
    return fetch('https://mhhunthelper.agiletravels.com/tracker.json')
        .then(async (response) => {
            if (!response.ok) throw `HTTP ${response.status}`;
            const { rh } = await response.json();
            Logger.log(`Relic Hunter: MHCT query OK, location: ${rh.location}, last_seen: ${rh.last_seen}`);
            const last_seen = Number(rh.last_seen);
            return {
                source: 'MHCT',
                last_seen: DateTime.fromSeconds(isNaN(last_seen) ? 0 : last_seen),
                location: rh.location,
            };
        })
        .catch((err) => {
            Logger.error('Relic Hunter: MHCT query failed:', err);
            return { source: 'MHCT', location: 'unknown' };
        });
}

/**
 * Processes a request to find the relic hunter
 * @param {TextChannel} channel the channel on which to respond.
 */
async function findRH(channel) {
    const asMessage = (location) => {
        let message = (location !== 'unknown')
            ? `Relic Hunter has been spotted in **${location}**`
            : 'Relic Hunter has not been spotted yet';
        message += ` and moves again ${timeLeft(DateTime.utc().endOf('day'))}`;
        return message;
    };
    const original_location = relic_hunter.location;
    // If we have MHCT data from today, trust it, otherwise attempt to update our known location.
    if (relic_hunter.source !== 'MHCT' || !DateTime.utc().hasSame(relic_hunter.last_seen, 'day')) {
        Logger.log(`Relic Hunter: location requested, might be "${original_location}"`);
        await getRHLocation();
        Logger.log(`Relic Hunter: location update completed, is now "${relic_hunter.location}"`);
    }

    channel.send(asMessage(relic_hunter.location))
        .catch((err) => Logger.error('Relic Hunter: Could not send response to Find RH request', err));
    if (relic_hunter.location !== 'unknown' && relic_hunter.location !== original_location) {
        setImmediate(remindRH, relic_hunter.location);
    }
}

//Resources:
//Timezones in Discord: https://www.reddit.com/r/discordapp/comments/68zkfs/timezone_tag_bot/
//Location nicknames as csv: https://docs.google.com/spreadsheets/d/e/2PACX-1vQRxGO1iLgX6N2P2iUT57ftCbh5lv_cmnatC6F8NevrdYDtumjcIJw-ooAqm1vIjSu6b0HfP4v2DYil/pub?gid=0&single=true&output=csv
//Loot nicknames as csv:     https://docs.google.com/spreadsheets/d/e/2PACX-1vQRxGO1iLgX6N2P2iUT57ftCbh5lv_cmnatC6F8NevrdYDtumjcIJw-ooAqm1vIjSu6b0HfP4v2DYil/pub?gid=1181602359&single=true&output=csv
//Mice nicknames as csv:     https://docs.google.com/spreadsheets/d/e/2PACX-1vQRxGO1iLgX6N2P2iUT57ftCbh5lv_cmnatC6F8NevrdYDtumjcIJw-ooAqm1vIjSu6b0HfP4v2DYil/pub?gid=762700375&single=true&output=csv