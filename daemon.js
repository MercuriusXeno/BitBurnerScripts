// the purpose of the daemon is: it's our global starting point.
// it handles several aspects of the game, primarily hacking for money.
// since it requires a robust "execute arbitrarily" functionality
// it serves as the launching point for all the helper scripts we need.
// this list has been steadily growing as time passes.

/*jshint loopfunc:true */

// --- CONSTANTS ---
// track how costly (in security) a growth/hacking thread is.
const growthThreadHardening = 0.004;
const hackThreadHardening = 0.002;

// initial potency of weaken threads before multipliers
const weakenThreadPotency = 0.05;

// unadjusted server growth rate, this is way more than what you actually get
const unadjustedGrowthRate = 1.03;

// max server growth rate, growth rates higher than this are throttled.
const maxGrowthRate = 1.0035;

// the number of milliseconds to delay the grow execution after theft, for timing reasons
// the delay between each step should be *close* 1/4th of this number, but there is some imprecision
var arbitraryExecutionDelay = 6000;

// the delay that it can take for a script to start, used to pessimistically schedule things in advance
var queueDelay = 6000;

// the max number of batches this daemon will spool up to avoid running out of IRL ram
var maxBatches = 30;

// the max number of targets this daemon will run workers against to avoid running out of IRL ram
var maxTargets = 100;

// The maximum current total RAM utilization before we stop attempting to schedule work for the next less profitable server
var maxUtilization = 0.95;

// Maximum number of milliseconds the main targetting loop should run before we take a break until the next loop
var maxLoopTime = 1000; //ms


// some ancillary scripts that run asynchronously, we utilize the startup/execute capabilities of this daemon to run when able
var asynchronousHelpers = [
    { name: "host-manager.js", shortName: "host" },
    { name: "node-manager.js", shortName: "node" },
    { name: "tor-manager.js", shortName: "tor" },
    { name: "program-manager.js", shortName: "prog" },
    { name: "ram-manager.js", shortName: "ram" },
    { name: "agency-manager.js", shortName: "agent" },
    { name: "aug-manager.js", shortName: "aug" },
    { name: "stockmaster.ns", shortName: "stockmaster" }
];
// The primary tools copied around and used for hacking
var hackTools = [
    { name: "weak-target.js", shortName: "weak" },
    { name: "grow-target.js", shortName: "grow" },
    { name: "hack-target.js", shortName: "hack" }
];

// --- VARS ---
// don't grow or shrink, just hack
var hackOnly = false;

// complex arrays of servers with relevant properties, one is sorted for ram available, the other is for money
var serverListRam = [];
var serverListTotalRam = [];
var serverListMoney = [];

// simple name array of servers that have been added
var addedServers = [];

// the port cracking array, we use this to do some things
var portCrackers = [];

// toolkit var for remembering the names and costs of the scripts we use the most
var tools = [];

// the name of the host of this daemon, so we don't have to call the function more than once.
var daemonHost = null;

// multipliers for player abilities
var mults = null;
var playerHackingMoneyMult = null;
var playerHackingGrowMult = null;

// bitnode multipliers that can be automatically set by SF-5
var bitnodeMults = null;
var bitnodeHackingMoneyMult = null;
var bitnodeGrowMult = null;
var bitnodeWeakenMult = null;

// cache ns logged properties to reduce log noise
var cachedNs = null;

// script entry point
export async function main(ns) {
    // reset a bunch of stuff, hoping this fixes reset issues.
    serverListRam = [];
    serverListMoney = [];
    serverListTotalRam = [];
    addedServers = [];
    portCrackers = [];
    tools = [];

    cachedNs = ns;
    ns.disableLog('ALL')
    // Process args (if any)
    if (ns.args.length > 0 && ns.args[0] == '-h')
        hackOnly = true;
    if (hackOnly) {
        queueDelay = arbitraryExecutionDelay = 1000;
        maxBatches = 1;
    }

    // Initialize all helper tools with a property indicating whether they're running
    asynchronousHelpers.forEach(function(tool) { tool.isLaunched = false; });

    daemonHost = ns.getHostname(); // get the name of this node 
    await buildServerList(ns); // create the exhaustive server list    
    buildPortCrackingArray(ns); // build port cracking array    
    buildToolkit(ns); // build toolkit    
    establishMultipliers(ns); // figure out the various bitnode and player multipliers
    await runStartupScripts(ns); // Start helper scripts

    // the actual worker processes live here
    await doTargetingLoop(ns);
}

// actual multipliers are expressed as functions
function actualHackMultiplier() {
    return playerHackingMoneyMult * bitnodeHackingMoneyMult;
}

function actualWeakenPotency() {
    return bitnodeWeakenMult * weakenThreadPotency;
}

// Check running status of scripts on servers
function whichServerIsRunning(scriptName) {
    for (var s = 0; s < serverListRam.length; s++) {
        var server = serverListRam[s];
        if (server.hasRunningScript(scriptName)) {
            return server.name;
        }
    }
    return null;
}
// Helper to kick off helper scripts
async function runStartupScripts(ns) {
    ns.print("runStartupScripts");
    for (var h = 0; h < asynchronousHelpers.length; h++) {
        var helper = asynchronousHelpers[h];
        if (helper.isLaunched)
            continue;
        var scriptName = helper.name;
        if (whichServerIsRunning(scriptName) != null) {
            helper.isLaunched = true;
            continue;
        } else {
            var tool = getTool(helper.shortName);
            helper.isLaunched = await arbitraryExecution(ns, tool, 1, []);
            if (helper.isLaunched) {
                ns.print("Server " + whichServerIsRunning(scriptName) + " running tool: " + scriptName);
            } else {
                ns.print("Tool cannot be run (does not exist?): " + scriptName);
            }
        }
    }
    // if every helper is launched already return "true" so we can skip doing this each cycle going forward.
    for (var c = 0; c < asynchronousHelpers.length; c++) {
        if (!asynchronousHelpers[c].isLaunched) {
            return false;
        }
    }
    return true;
}
// Compute RAM utilization across all owned+hacked servers
function getTotalServerUtilization() {
    var totalUsedRam = 0;
    var totalMaxRam = 0;
    for (var i = 0; i < serverListTotalRam.length; i++) {
        var server = serverListTotalRam[i];
        totalMaxRam += server.totalRam();
        totalUsedRam += server.usedRam();
    }
    return totalUsedRam / totalMaxRam;
}

// Property to avoid log churn if our status hasn't changed since the last loop
var lastTargetingLog = "";
// Main targetting loop
async function doTargetingLoop(ns) {
    ns.print("doTargetingLoop");
    //var isHelperListLaunched = false; // Uncomment this and related code to keep trying to start helpers
    while (true) {
        var start = Date.now()
        // Check if any new servers have been purchased by the external host_manager process
        detectChangesInDaemonHosts(ns);

        // run some auxilliary processes that ease the ram burden of this daemon
        // and add additional functionality (like managing hacknet or buying servers)
        //if (!isHelperListLaunched) {
        //	isHelperListLaunched = await runStartupScripts(ns);
        //}

        // sort the array so that already weakened servers have a high priority
        // while still taking their value into account
        sortServerList("money");
        var currentTargets = 0;
        var prepping = [];
        var targetting = [];
        var notRooted = [];
        var cantHack = [];
        var noMoney = [];
        var notOptimized = [];
        var skipped = [];
        var lowestUnhackable = 99999;
        var totalServerUtilization = null;
        var loopCapped = false;

        // check for servers that need to be rooted
        // simultaneously compare our current target to potential targets
        for (var i = 0; i < serverListMoney.length; i++) {
            var server = serverListMoney[i];
            // check if we have root
            if (!server.hasRoot()) {
                // if we don't, and we can, get it.
                if (server.canCrack()) {
                    doRoot(server);
                }
            }

            if (totalServerUtilization == null)
                totalServerUtilization = getTotalServerUtilization();

            if (!server.hasRoot()) { // Can't do anything to servers we have not yet cracked
                notRooted.push(server);
            } else if (!server.shouldHack()) { // Ignore servers we own (bought servers / home / no money)
                noMoney.push(server);
            } else if (server.isTargeting()) { // Already targeting from a prior loop
                targetting.push(server);
                currentTargets++;
            } else if (server.isPrepping()) { // Already prepping from a prior loop
                prepping.push(server);
                currentTargets++;
            } else if (!server.canHack()) { // Servers above our Hack skill
                // TODO: We should still be able to weaken these targets if we have spare ram at the end of it all
                cantHack.push(server);
                lowestUnhackable = Math.min(lowestUnhackable, server.hackingRequired);
            } else if ( // Below are a series of conditions for which we'll postpone any additional work on servers
                currentTargets >= maxTargets || // User-configurable hard cap on number of targets (to reduce IRL RAM usage)
                totalServerUtilization >= maxUtilization || // Start with most profitable servers, stop when we run out of usable RAM
                ((Date.now() - start) >= maxLoopTime)) { // To avoid lagging the game, wait until the next loop to keep doing work
                loopCapped = true;
                skipped = serverListMoney.slice(i);
                break;
            } else {
                currentTargets++;
                // Any actions taken below will require us to recompute server utilization before the next iteration
                totalServerUtilization = null;
                // Perform weakening and initial growth until the server is "perfected" (unless in hack-only mode)
                if (!hackOnly) {
                    await prepServer(ns, server);

                    // Now don't do anything to it until prep finishes
                    if (server.isPrepping()) {
                        prepping.push(server);
                        continue;
                    }

                    // the server isn't optimized, this means we're out of ram from a more optimal target?
                    // TODO: this code may be obsolete from before prepping was asynchronous?
                    if (server.security() > server.minSecurity || server.money() < server.maxMoney) {
                        ns.print('Server "' + server.name + '" not optimized. Out of ram?')
                        notOptimized.push(server)
                        currentTargets--;
                        continue;
                    }
                }

                // adjust the percentage to steal until it's able to rapid fire as many as it can
                await optimizePerformanceMetrics(ns, server);

                // once conditions are optimal, fire barrage after barrage of cycles in a schedule
                await performScheduling(ns, server);
                targetting.push(server);
            }
        }

        // Mini-loop for servers that we can't hack yet, but might have access to soon, we can at least prep them.
        if (cantHack.length > 0 && !loopCapped) {
            // Prep in order of soonest to become available to us
            cantHack.sort(function(a, b) {
                var diff = a.hackingRequired - b.hackingRequired;
                return diff != 0.0 ? diff : b.name - a.name; // Break ties by sorting by name
            });
            // Prep them all unless one of our capping rules are hit
            for (var i = 0; i < cantHack.length; i++) {
                var server = cantHack[i];
                if (currentTargets >= maxTargets || getTotalServerUtilization() >= maxUtilization || ((Date.now() - start) >= maxLoopTime))
                    break;
                // Assume we are not already prepping this server or, it would be in prepping[] instead of cantHack[]
                await prepServer(ns, server);
                prepping.push(server);
                currentTargets++;
            }
        }

        // Log some status updates
        var targetingLog = (
            '\n > ' + noMoney.length + ' servers ignored (owned / no money)' +
            (notRooted.length == 0 ? '' : '\n > ' + notRooted.length + ' servers not rooted') +
            (cantHack.length == 0 ? '' : '\n > ' + cantHack.length + ' servers cannot be hacked (next at ' + lowestUnhackable + ')') +
            (notOptimized.length == 0 ? '' : '\n > ' + notOptimized.length + ' servers failed to be prepped (not optimized?)') +
            '\n > ' + prepping.length + ' being prepped' +
            '\n > ' + targetting.length + ' being targetted' +
            (skipped.length == 0 ? '' : '\n > ' + skipped.length + ' servers skipped (time, RAM, or target cap)'));
        if (targetingLog != lastTargetingLog)
            ns.print('Targetting loop ran in ' + ((Date.now() - start) / 1000).toFixed(1) + "s:" + (lastTargetingLog = targetingLog) +
                '\n > RAM Utilization: ' + (getTotalServerUtilization() * 100).toFixed(2) + '% (max ' + (maxUtilization * 100).toFixed(0) + '%) ' +
                'running jobs against ' + currentTargets + ' servers');
        //ns.print('Prepping: ' + prepping.map(s => s.name).join(', '))
        //ns.print('Targetting: ' + targetting.map(s => s.name).join(', '))
        await ns.sleep(1000);
    }
}

function establishMultipliers(ns) {
    ns.print("establishMultipliers");
    // uncomment this at SF-5 to handle your bitnode multipliers for you
    // bitnodeMults = ns.getBitNodeMultipliers();

    // prior to SF-5, bitnodeMults stays null and these mults are set to 1.
    var isBitnodeMultsNull = bitnodeMults === null;

    // various bitnode mult setters:
    bitnodeHackingMoneyMult = isBitnodeMultsNull ? 1 : bitnodeMults.ScriptHackMoney; //applying the multiplier directly to the player mult
    bitnodeGrowMult = isBitnodeMultsNull ? 1 : bitnodeMults.ServerGrowthRate;
    bitnodeWeakenMult = isBitnodeMultsNull ? 1 : bitnodeMults.ServerWeakenRate;

    // then do player multipliers:
    mults = ns.getHackingMultipliers();

    // multiplier for hacking yields, factors into how many theft threads are needed.
    playerHackingMoneyMult = mults.money;

    // growth multiplier, factors into how many growth threads are needed.
    playerHackingGrowMult = mults.growth;
}

function buildToolkit(ns) {
    ns.print("buildToolkit");
    var allTools = hackTools.concat(asynchronousHelpers);
    //asynchronousHelpers
    for (var i = 0; i < allTools.length; i++) {
        var tool = {
            instance: ns,
            name: allTools[i].name,
            cost: ns.getScriptRam(allTools[i].name, daemonHost),
            // I like short names. 
            shortName: allTools[i].shortName,
            canRun: function(server) {
                return doesServerHaveFile(this.instance, this.name, server.name) && server.ramAvailable() >= this.cost;
            },
            isThreadSpreadingAllowed: function() { return this.shortName === "weak"; },
            getMaxThreads: function() {
                // analyzes the daemon servers array and figures about how many threads can be spooled up across all of them.
                var maxThreads = 0;
                sortServerList("ram");
                for (var i = 0; i < serverListRam.length; i++) {
                    var daemonServer = serverListRam[i];
                    // you don't count lol
                    if (!daemonServer.hasRoot())
                        continue;
                    var threadsHere = Math.floor(daemonServer.ramAvailable() / this.cost);
                    if (!this.isThreadSpreadingAllowed())
                        return threadsHere;
                    maxThreads += threadsHere;
                }
                return maxThreads;
            }
        }
        tools.push(tool);
    }
}

function doesServerHaveFile(ns, fileName, serverName) {
    //ns.print("doesServerHaveFile Server: " + serverName + "  File: " + fileName);
    return ns.fileExists(fileName, serverName);
}

// assemble a list of port crackers and abstract their functionality
function buildPortCrackingArray(ns) {
    ns.print("buildPortCrackingArray");
    var crackNames = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];
    for (var i = 0; i < crackNames.length; i++) {
        var cracker = buildPortCrackerObject(ns, crackNames[i]);
        portCrackers.push(cracker);
    }
}

function buildPortCrackerObject(ns, crackName) {
    var crack = {
        instance: ns,
        name: crackName,
        exists: function() { return this.instance.fileExists(crackName, "home"); },
        runAt: function(target) {
            switch (this.name) {
                case "BruteSSH.exe":
                    this.instance.brutessh(target);
                    break;
                case "FTPCrack.exe":
                    this.instance.ftpcrack(target);
                    break;
                case "relaySMTP.exe":
                    this.instance.relaysmtp(target);
                    break;
                case "HTTPWorm.exe":
                    this.instance.httpworm(target);
                    break;
                case "SQLInject.exe":
                    this.instance.sqlinject(target);
                    break;
            }
        },
        // I made this a function of the crackers out of laziness.
        doNuke: function(target) {
            this.instance.nuke(target);
        }
    }
    return crack;
}

function doRoot(server) {
    var portsCracked = 0;
    var portsNeeded = server.portsRequired;
    for (var i = 0; i < portCrackers.length; i++) {
        var cracker = portCrackers[i];
        if (cracker.exists()) {
            cracker.runAt(server.name);
            portsCracked++;
        }
        if (portsCracked >= portsNeeded) {
            cracker.doNuke(server.name);
            break;
        }
    }
}

function detectChangesInDaemonHosts(ns) {
    //ns.print("detectChangesInDaemonHosts");
    var purchasedServers = ns.getPurchasedServers();
    for (var p = 0; p < purchasedServers.length; p++) {
        var hostName = purchasedServers[p];
        if (addedServers.includes(hostName))
            continue;
        addServer(buildServerObject(ns, hostName));
    }
}

function sortServerList(o) {
    switch (o) {
        case "ram":
            // Original sort order adds jobs to the server with the most free ram
            serverListRam.sort(function(a, b) {
                var ramDiff = b.ramAvailable() - a.ramAvailable();
                return ramDiff != 0.0 ? ramDiff : b.name - a.name; // Break ties by sorting by name
            });
            break;
        case "totalram":
            // Original sort order adds jobs to the server with the most free ram
            serverListTotalRam.sort(function(a, b) {
                var ramDiff = b.totalRam() - a.totalRam();
                return ramDiff != 0.0 ? ramDiff : b.name - a.name; // Break ties by sorting by name
            });
            break;
        case "money":
            serverListMoney.sort(function(a, b) {
                var moneyDiff = b.sortValue() - a.sortValue();
                return moneyDiff != 0.0 ? moneyDiff : b.name - a.name; // Break ties by sorting by name
            });
            break;
    }
}

async function optimizePerformanceMetrics(ns, currentTarget) {
    var isOptimal = false;
    var hasChanged = false;
    var start = Date.now();
    for (var attempts = 0; attempts < 100 && !isOptimal; attempts++) {
        var snapshot = getPerformanceSnapshot(currentTarget);
        var adjustment = analyzeSnapshot(snapshot, currentTarget);
        if (adjustment === 0.00) {
            isOptimal = true;
        } else {
            hasChanged = true;
            currentTarget.percentageToSteal += adjustment;
        }
    }
    if (hasChanged) {
        ns.print('Tuned cycles to steal ' + (Math.floor(currentTarget.actualPercentageToSteal() * 10000) / 100).toFixed(2) + "% (" + currentTarget.name + ")" +
            " Time: " + ((Date.now() - start) / 1000).toFixed(2) + "s" + " its: " + attempts);
    }
}

// return the adjustment quantity based on current performance metrics
// -1 adjusts down, 1 adjusts up, 0 means don't do anything.
function analyzeSnapshot(snapshot, currentTarget) {
    // always overshoot the target. this is the priority.
    var snapshotMaxCycles = snapshot.maxCompleteCycles();
    if (snapshotMaxCycles < snapshot.optimalPacedCycles && currentTarget.percentageToSteal > 0.01) {
        return -0.01;
    } else if (snapshotMaxCycles > snapshot.optimalPacedCycles && currentTarget.percentageToSteal < 0.98) {
        // if we're already overshooting the target, check that an adjustment
        // doesn't *undershoot* it, because that's bad. we don't want that.
        currentTarget.percentageToSteal += 0.01;
        var comparisonSnapshot = getPerformanceSnapshot(currentTarget);
        currentTarget.percentageToSteal -= 0.01;
        if (comparisonSnapshot.maxCompleteCycles() < comparisonSnapshot.optimalPacedCycles) {
            return 0.00;
        } else {
            return 0.01;
        }
    }
    return 0.00;
}

// return a performance snapshot to compare against optimal, or another snapshot
function getPerformanceSnapshot(currentTarget) {
    var snapshot = {
        optimalBatchCost: getOptimalBatchCost(currentTarget),
        optimalPacedCycles: Math.min(maxBatches, Math.max(1, Math.floor((currentTarget.timeToWeaken() * 1000 - queueDelay) / arbitraryExecutionDelay))),
        maxCompleteCycles: function() {
            // total number of cycles is the max you can across all hosts
            var maxCycles = 0;
            for (var i = 0; i < serverListRam.length; i++)
                maxCycles += Math.floor(serverListRam[i].ramAvailable() / this.optimalBatchCost);
            return maxCycles;
        }
    };
    return snapshot;
}

function getOptimalBatchCost(currentTarget) {
    var weakenTool = getTool("weak");
    var growTool = getTool("grow");
    var hackTool = getTool("hack");
    var weakenCost = currentTarget.weakenThreadTotalPerCycle() * weakenTool.cost;
    var growCost = currentTarget.growThreadsNeededAfterTheft() * growTool.cost;
    var hackCost = currentTarget.hackThreadsNeeded() * hackTool.cost;
    var totalCost = weakenCost + growCost + hackCost;
    return totalCost;
}

async function performScheduling(ns, currentTarget) {
    var firstEnding = null;
    var lastStart = null;
    var scheduledTasks = [];

    var snapshot = getPerformanceSnapshot(currentTarget);
    var maxCycles = Math.min(snapshot.optimalPacedCycles, snapshot.maxCompleteCycles());
    var start = Date.now();
    var now = new Date(start + queueDelay);
    var lastBatch = 0;

    var start = Date.now();
    // Create all batches with appropriate timing delays
    for (var cyclesScheduled = 0; cyclesScheduled < maxCycles; cyclesScheduled++) {
        var newBatchStart = (scheduledTasks.length === 0) ? now : new Date(lastBatch.getTime() + arbitraryExecutionDelay);
        lastBatch = new Date(newBatchStart.getTime());
        var newBatch = getScheduleTiming(ns, newBatchStart, currentTarget, scheduledTasks.length);
        if (firstEnding === null)
            firstEnding = new Date(newBatch.hackEnd.valueOf());
        if (lastStart === null || lastStart < newBatch.firstFire)
            lastStart = new Date(newBatch.firstFire.valueOf());
        if (lastStart >= firstEnding)
            break;
        scheduledTasks.push(newBatch);
    }
    // Execute all batches (TODO: Question why we would schedule these all in advance instead of as they complete?)
    for (var i = 0; i < scheduledTasks.length; i++) {
        var schedObj = scheduledTasks[i];
        for (var s = 0; s < schedObj.scheduleItems.length; s++) {
            var schedItem = schedObj.scheduleItems[s];
            if (!schedItem.itemRunning) {
                schedItem.itemRunning = true;
                var tool = getTool(schedItem.toolShortName);
                var threads = schedItem.threadsNeeded;
                var discriminationArg = schedObj.batchNumber.toString() + "-" + s.toString();
                var executionTime = 0;
                switch (schedItem.toolShortName) {
                    case "hack":
                        executionTime = currentTarget.timeToHack() * 1000;
                        break;
                    case "grow":
                        executionTime = currentTarget.timeToGrow() * 1000;
                        break;
                    case "weak":
                        executionTime = currentTarget.timeToWeaken() * 1000;
                        break;
                }
                await arbitraryExecution(ns, tool, threads, [currentTarget.name, schedItem.start.getTime(), schedItem.end.getTime(), executionTime, discriminationArg]);
            }
        }
    }
    ns.print("Scheduled " + maxCycles + " batches, ~" + Math.floor(currentTarget.timeToWeaken() * 2) + "s delay (" + currentTarget.name + ")" +
        " Time: " + ((Date.now() - start) / 1000).toFixed(2) + "s");
}

// returns an object that contains all 4 timed events start and end times as dates
function getScheduleTiming(ns, fromDate, currentTarget, batchNumber) {
    // spacing interval used to pace our script resolution
    var delayInterval = arbitraryExecutionDelay / 4;

    // first to fire
    var hackTime = currentTarget.timeToHack() * 1000;

    // second to fire
    var weakenTime = currentTarget.timeToWeaken() * 1000;

    // third to fire
    var growTime = currentTarget.timeToGrow() * 1000;

    // fourth to fire, we apply the interval here
    var weakenSecondTime = currentTarget.timeToWeaken() * 1000 + delayInterval * 3;

    // first, assume we're executing all these scripts pretty much instantly
    var time = new Date(fromDate.valueOf());

    // next, take the last possible execution time and work backwards, subtracting a small interval
    var finalWeakenResolvesAt = new Date(time.valueOf());
    finalWeakenResolvesAt.setTime(finalWeakenResolvesAt.getTime() + weakenSecondTime);

    // step 3 (grow back) should resolve "delay" before the final weaken.
    var growResolvesAt = new Date(finalWeakenResolvesAt.valueOf());
    growResolvesAt.setTime(growResolvesAt.getTime() - delayInterval);

    // step 2 (weaken after hack) should resolve "delay" before the grow.
    var weakenResolvesAt = new Date(growResolvesAt.valueOf());
    weakenResolvesAt.setTime(weakenResolvesAt.getTime() - delayInterval);

    // step 1 (steal a bunch of money) should resolve "delay" before its respective weaken.
    var hackResolvesAt = new Date(weakenResolvesAt.valueOf());
    hackResolvesAt.setTime(hackResolvesAt.getTime() - delayInterval);

    // from these optimal resolution times, determine when to execute each
    var fireHackAt = new Date(hackResolvesAt.valueOf());
    fireHackAt.setTime(hackOnly ? time : fireHackAt.getTime() - hackTime);

    var fireFirstWeakenAt = new Date(weakenResolvesAt.valueOf());
    fireFirstWeakenAt.setTime(fireFirstWeakenAt.getTime() - weakenTime);

    var fireGrowAt = new Date(growResolvesAt.valueOf());
    fireGrowAt.setTime(fireGrowAt.getTime() - growTime);

    var fireSecondWeakenAt = new Date(finalWeakenResolvesAt.valueOf());
    fireSecondWeakenAt.setTime(fireSecondWeakenAt.getTime() - weakenTime);

    var firstThingThatFires = new Date(Math.min(fireSecondWeakenAt.getTime(), fireGrowAt.getTime(), fireFirstWeakenAt.getTime(), fireHackAt.getTime()));
    var batchTiming = {
        batchStart: time,
        firstFire: firstThingThatFires,
        hackStart: fireHackAt,
        hackEnd: hackResolvesAt,
        firstWeakenStart: fireFirstWeakenAt,
        firstWeakenEnd: weakenResolvesAt,
        growStart: fireGrowAt,
        growEnd: growResolvesAt,
        secondWeakenStart: fireSecondWeakenAt,
        secondWeakenEnd: finalWeakenResolvesAt
    };

    var schedObj = getScheduleObject(batchTiming, currentTarget, batchNumber);

    return schedObj;
}

function getTool(s) {
    for (var i = 0; i < tools.length; i++) {
        if (tools[i].shortName == s) {
            return tools[i];
        }
    }
    return null;
}

// intended as a high-powered figure-this-out-for-me run command.
// if it can't run all the threads at once, it runs as many as it can
// across the spectrum of daemons available.
async function arbitraryExecution(ns, tool, threads, args) {
    sortServerList("ram");
    // Sort servers by total ram, and try to fill these before utilizing another server.
    sortServerList("totalram");
    var preferredServerOrder = serverListTotalRam.slice()
    // Hack: Home is more effective at grow() and weaken() than other nodes (multiple cores)
    // so if this is one of those tools, put it at the front of the list of preferred candidates
    var home = preferredServerOrder.splice(preferredServerOrder.findIndex(i => i.name == "home"), 1)[0]
    if (tool.shortName == "grow" || tool.shortName == "weak")
        preferredServerOrder.unshift(home)
    else
        preferredServerOrder.push(home)

    // For a fun alternative - fill up small servers before utilizing larger ones (can be laggy)
    //for (var i = serverListRam.length - 1; i >=0; i--) {
    for (var i = 0; i < serverListRam.length; i++) {
        // we've done it, move on.
        if (threads <= 0)
            return true;
        var sourceServer = serverListRam[i];
        var maxThreadsHere = Math.min(threads, Math.floor(sourceServer.ramAvailable() / tool.cost));

        // If this server can handle all required threads, see if another server that is more preferred, but perhaps has less free space,
        // also has room - and prefer to pack this one with more jobs before utilizing another server.
        if (maxThreadsHere == threads) {
            for (var j = 0; j < preferredServerOrder.length; j++) {
                var nextBestServer = preferredServerOrder[j];
                // If the next largest server is also the current server with the most capacity, then it's the best one to pack
                if (nextBestServer == sourceServer)
                    break;
                // If the job can just as easily fit on this server, prefer to put the job there
                var maxThreadsThere = Math.min(threads, Math.floor(nextBestServer.ramAvailable() / tool.cost));
                if (maxThreadsThere == threads) {
                    sourceServer = nextBestServer;
                    break;
                }
            }
        }

        // if we don't have root, we don't have exec privileges, move on.
        if (!sourceServer.hasRoot())
            continue;
        if (maxThreadsHere <= 0)
            continue;

        // if we're coming from the daemon host, we can use run
        if (sourceServer.name == daemonHost) {
            var runArgs = [tool.name, maxThreadsHere].concat(args);
            await ns.run.apply(null, runArgs);
        } else {
            // if not, we use a remote execute, with a script copy check.
            if (!doesServerHaveFile(ns, tool.name, sourceServer.name)) {
                ns.scp(tool.name, daemonHost, sourceServer.name);
            }
            var execArgs = [tool.name, sourceServer.name, maxThreadsHere].concat(args);
            var pid = await ns.exec.apply(null, execArgs);
            if (pid == 0)
                return false;
        }
        // Decrement the threads that have been successfully scheduled
        threads -= maxThreadsHere;
        continue;
    }
    // the run failed if there were threads left to schedule after we exhausted our pool of servers
    return threads == 0;
}

// brings the server down to minimum security to prepare for cycling scheduler activity
async function prepServer(ns, currentTarget) {
    // once we're in scheduling mode, presume prep server is to be skipped.
    if (currentTarget.isTargeting())
        return;
    var start = Date.now();
    var now = new Date(start.valueOf());
    if (currentTarget.security() > currentTarget.minSecurity || currentTarget.money() < currentTarget.maxMoney) {
        var trueGrowThreadsNeeded = 0;
        var weakenTool = getTool("weak");
        var threadsNeeded = 0;
        var weakenForGrowthThreadsNeeded = 0;
        if (currentTarget.money() < currentTarget.maxMoney) {
            var growTool = getTool("grow");
            var growThreadsAllowable = growTool.getMaxThreads();
            var growThreadsNeeded = currentTarget.growThreadsNeeded();
            trueGrowThreadsNeeded = Math.min(growThreadsAllowable, growThreadsNeeded);
            weakenForGrowthThreadsNeeded = Math.ceil(trueGrowThreadsNeeded * growthThreadHardening / actualWeakenPotency());
            var growThreadThreshold = (growThreadsAllowable - growThreadsNeeded) * (growTool.cost / weakenTool.cost);
            var growThreadsReleased = weakenTool.cost / growTool.cost * (weakenForGrowthThreadsNeeded + currentTarget.weakenThreadsNeeded());
            if (growThreadThreshold >= growThreadsReleased) {
                growThreadsReleased = 0;
            }
            trueGrowThreadsNeeded -= growThreadsReleased;
            if (trueGrowThreadsNeeded > 0) {
                await arbitraryExecution(ns, growTool, trueGrowThreadsNeeded, [currentTarget.name, now.getTime(), now.getTime(), 0, "prep"]);
            }
        }
        threadsNeeded = currentTarget.weakenThreadsNeeded() + weakenForGrowthThreadsNeeded;
        var threadSleep = currentTarget.timeToWeaken() * 1000 + queueDelay;
        var threadsAllowable = weakenTool.getMaxThreads();
        var trueThreads = Math.min(threadsAllowable, threadsNeeded);
        if (trueThreads > 0) {
            ns.print("Prepping with " + Math.floor(threadSleep / 1000) + "s delay (" + currentTarget.name + ")" +
                " Time: " + ((Date.now() - start) / 1000).toFixed(2) + "s");
            await arbitraryExecution(ns, weakenTool, trueThreads, [currentTarget.name, now.getTime(), now.getTime(), 0, "prep"]);
        }
    }
}

function buildServerObject(ns, node) {
    var server = {
        instance: ns,
        name: node,
        minSecurity: ns.getServerMinSecurityLevel(node),
        hackingRequired: ns.getServerRequiredHackingLevel(node),
        portsRequired: ns.getServerNumPortsRequired(node),
        maxMoney: ns.getServerMaxMoney(node),
        percentageToSteal: 0.5,
        sortValue: function() {
            // if the server is at base security, prioritize it.
            // we do this by pretending the time to weaken is really really small.
            var timeToWeakenVar = this.timeToWeaken();
            if (this.security() > this.minSecurity) {
                timeToWeakenVar = 1;
            }
            return this.maxMoney / (timeToWeakenVar * 2);
        },
        canCrack: function() { return getPortCrackers(this.instance) >= this.portsRequired },
        canHack: function() { return this.hackingRequired <= ns.getHackingLevel(); },
        shouldHack: function() { return this.maxMoney > 0 && this.name !== "home" && !this.instance.getPurchasedServers().includes(this.name); },
        money: function() { return ns.getServerMoneyAvailable(this.name); },
        security: function() { return ns.getServerSecurityLevel(this.name); },
        isPrepping: function() {
            var toolNames = hackTools.map(t => t.name);
            // then figure out if the servers are running the other 2, that means prep
            for (var s = 0; s < serverListRam.length; s++) {
                var ps = this.instance.ps(serverListRam[s].name);
                for (var p = 0; p < ps.length; p++) {
                    var tps = ps[p];
                    if (toolNames.includes(tps.filename) && tps.args[0] == this.name) {
                        if (tps.args.length > 4 && tps.args[4] == "prep") {
                            return true;
                        }
                    }
                }
            }
            return false;
        },
        isTargeting: function() {
            var toolNames = hackTools.map(t => t.name);
            // figure out if any server in the network is running scripts against this server
            for (var s = 0; s < serverListRam.length; s++) {
                var ps = this.instance.ps(serverListRam[s].name);
                for (var p = 0; p < ps.length; p++) {
                    var tps = ps[p];
                    if (toolNames.includes(tps.filename) && tps.args[0] == this.name) {
                        if (tps.args.length > 4 && tps.args[4] != "prep") {
                            return true;
                        }
                    }
                }
            }
            return false;
        },
        hasRunningScript: function(scriptName) {
            return this.instance.scriptRunning(scriptName, this.name);
        },
        serverGrowthPercentage: function() {
            return this.instance.getServerGrowth(this.name) * bitnodeGrowMult * playerHackingGrowMult / 100;
        },
        adjustedGrowthRate: function() { return Math.min(maxGrowthRate, 1 + ((unadjustedGrowthRate - 1) / this.minSecurity)); },
        actualServerGrowthRate: function() {
            return Math.pow(this.adjustedGrowthRate(), this.serverGrowthPercentage());
        },
        // this is the target growth coefficient *immediately*
        targetGrowthCoefficient: function() {
            return this.maxMoney / Math.max(this.money(), 1);
        },
        // this is the target growth coefficient per cycle, based on theft
        targetGrowthCoefficientAfterTheft: function() {
            return 1 / (1 - (this.hackThreadsNeeded() * this.percentageStolenPerHackThread()));
        },
        cyclesNeededForGrowthCoefficient: function() {
            return Math.log(this.targetGrowthCoefficient()) / Math.log(this.adjustedGrowthRate());
        },
        cyclesNeededForGrowthCoefficientAfterTheft: function() {
            return Math.log(this.targetGrowthCoefficientAfterTheft()) / Math.log(this.adjustedGrowthRate());
        },
        hackEaseCoefficient: function() {
            return (100 - Math.min(100, this.minSecurity)) / 100;
        },
        hackingSkillCoefficient: function() {
            var hackingLevel = ns.getHackingLevel()
            return (hackingLevel - (this.hackingRequired - 1)) / hackingLevel;
        },
        actualHackCoefficient: function() {
            return this.hackEaseCoefficient() * this.hackingSkillCoefficient() * actualHackMultiplier() / 240;
        },
        percentageStolenPerHackThread: function() {
            return Math.min(1, Math.max(0, this.actualHackCoefficient()));
        },
        actualPercentageToSteal: function() {
            return this.hackThreadsNeeded() * this.percentageStolenPerHackThread();
        },
        hackThreadsNeeded: function() {
            return Math.floor(this.percentageToSteal / this.percentageStolenPerHackThread());
        },
        growThreadsNeeded: function() {
            return Math.ceil(this.cyclesNeededForGrowthCoefficient() / this.serverGrowthPercentage());
        },
        growThreadsNeededAfterTheft: function() {
            return Math.ceil(this.cyclesNeededForGrowthCoefficientAfterTheft() / this.serverGrowthPercentage());
        },
        weakenThreadsNeededAfterTheft: function() {
            return Math.ceil(this.hackThreadsNeeded() * hackThreadHardening / actualWeakenPotency());
        },
        weakenThreadsNeededAfterGrowth: function() {
            return Math.ceil(this.growThreadsNeededAfterTheft() * growthThreadHardening / actualWeakenPotency());
        },
        weakenThreadTotalPerCycle: function() {
            return (this.weakenThreadsNeededAfterTheft() + this.weakenThreadsNeededAfterGrowth());
        },
        hasRoot: function() { return this.instance.hasRootAccess(this.name); },
        isHost: function() { return this.name == daemonHost; },
        getRam: function() { return ns.getServerRam(this.name); },
        ramAvailable: function() {
            var ramArray = this.getRam();
            return ramArray[0] - ramArray[1];
        },
        totalRam: function() { return this.getRam()[0]; },
        usedRam: function() { return this.getRam()[1]; },
        growDelay: function() { return this.timeToWeaken() - this.timeToGrow() + arbitraryExecutionDelay; },
        hackDelay: function() { return this.timeToWeaken() - this.timeToHack(); },
        timeToWeaken: function() { return this.instance.getWeakenTime(this.name); },
        timeToGrow: function() { return this.instance.getGrowTime(this.name); },
        timeToHack: function() { return this.instance.getHackTime(this.name); },
        weakenThreadsNeeded: function() { return Math.ceil((this.security() - this.minSecurity) / actualWeakenPotency()); }
    };
    return server;
}

// initialize a new incomplete schedule item
function getScheduleItem(toolShortName, start, end, threadsNeeded) {
    var schedItem = {
        toolShortName: toolShortName,
        start: start,
        end: end,
        threadsNeeded: threadsNeeded,
        itemRunning: false
    };
    return schedItem;
}

function getScheduleObject(batchTiming, currentTarget, batchNumber) {
    var schedItems = [];

    var schedItem0 = getScheduleItem("hack", batchTiming.hackStart, batchTiming.hackEnd, currentTarget.hackThreadsNeeded());
    var schedItem1 = getScheduleItem("weak", batchTiming.firstWeakenStart, batchTiming.firstWeakenEnd, currentTarget.weakenThreadsNeededAfterTheft());
    var schedItem2 = getScheduleItem("grow", batchTiming.growStart, batchTiming.growEnd, currentTarget.growThreadsNeededAfterTheft());
    var schedItem3 = getScheduleItem("weak", batchTiming.secondWeakenStart, batchTiming.secondWeakenEnd, currentTarget.weakenThreadsNeededAfterGrowth());

    schedItems.push(schedItem0);
    if (!hackOnly) {
        schedItems.push(schedItem1);
        schedItems.push(schedItem2);
        schedItems.push(schedItem3);
    }

    var scheduleObject = {
        batchNumber: batchNumber,
        batchStart: batchTiming.batchStart,
        firstFire: batchTiming.firstFire,
        hackEnd: batchTiming.hackEnd,
        batchFinish: hackOnly ? schedItem0.end : schedItem3.end,
        scheduleItems: schedItems
    };

    return scheduleObject;
}

function addServer(server) {
    serverListRam.push(server);
    serverListTotalRam.push(server);
    serverListMoney.push(server);
    addedServers.push(server.name);
}

function getPortCrackers(ns) {
    var count = 0;
    for (var i = 0; i < portCrackers.length; i++) {
        if (portCrackers[i].exists()) {
            count++;
        }
    }
    return count;
}

async function buildServerList(ns) {
    var startingNode = daemonHost;

    var hostsToScan = [];
    hostsToScan.push(startingNode);

    while (hostsToScan.length > 0) {
        var hostName = hostsToScan.pop();
        if (!addedServers.includes(hostName)) {
            var connectedHosts = ns.scan(hostName);
            for (var i = 0; i < connectedHosts.length; i++) {
                hostsToScan.push(connectedHosts[i]);
            }
            addServer(buildServerObject(ns, hostName));
        }
        await ns.sleep(10);
    }

    sortServerList("ram");
    sortServerList("money");
}
