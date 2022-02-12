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
const arbitraryExecutionDelay = 1000;

// the delay that it can take for a script to start, used to pessimistically schedule things in advance
const queueDelay = 2000;

// the max number of batches this daemon will spool up to avoid running out of IRL ram
const maxBatches = 60;

// the max number of targets this daemon will run workers against to avoid running out of IRL ram
const maxTargets = 5;

// some ancillary scripts that run asynchronously, we utilize the startup/execute capabilities of this daemon to run when able
var asynchronousHelpers = [];

// --- VARS ---
// in debug mode, the targeting loop will always go for foodnstuff, the saddest little server
var isDebugMode = false;

// the server to use if we're in debug mode
var debugServer = "omega-net";

// complex arrays of servers with relevant properties, one is sorted for ram available, the other is for money
var serverListRam = [];
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

// script entry point
export async function main(ns) {
    // reset a bunch of stuff, hoping this fixes reset issues.
    serverListRam = [];
    serverListMoney = [];
    addedServers = [];
    portCrackers = [];
    tools = [];

    // some ancillary scripts that run asynchronously, we utilize the startup/execute capabilities of this daemon to run when able
     asynchronousHelpers = [
        {name: "host-manager.ns", shortName: "host", isLaunched: false},
        {name: "node-manager.ns", shortName: "node", isLaunched: false}//,
        //{name: "tor-manager.ns", shortName: "tor", isLaunched: false},
        //{name: "program-manager.ns", shortName: "prog", isLaunched: false},
        //{name: "ram-manager.ns", shortName: "ram", isLaunched: false},
        //{name: "agency-manager.ns", shortName: "agent", isLaunched: false},
        //{name: "aug-manager.ns", shortName: "aug", isLaunched: false}
    ];
    
    // get the name of this node
    daemonHost = ns.getHostname();
    
    // create the exhaustive server list
    await buildServerList(ns);
    
    // build port cracking array
    buildPortCrackingArray(ns);
    
    // build toolkit
    buildToolkit(ns);
    
    // figure out the various bitnode and player multipliers
    establishMultipliers(ns);
    
    // the actual worker processes live here
    await doTargetingLoop(ns);
}

// actual multipliers are expressed as functions
function actualGrowthMultiplier() { 
    return playerHackingGrowMult * bitnodeGrowMult; 
}

function actualHackMultiplier() { 
    return playerHackingMoneyMult * bitnodeHackingMoneyMult; 
}

function actualWeakenPotency() { 
    return bitnodeWeakenMult * weakenThreadPotency;
}

function isAnyServerRunning(scriptName) {
    for (var s = 0; s < serverListRam.length; s++) {
        var server = serverListRam[s];
        if (server.hasRunningScript(scriptName)) {
            return true;
        }
    }
    return false;
}

function whichServerIsRunning(scriptName) {
    for (var s = 0; s < serverListRam.length; s++) {
        var server = serverListRam[s];
        if (server.hasRunningScript(scriptName)) {
            return server.name;
        }
    }
    return "";
}

async function runStartupScripts(ns) {
    var isEverythingAlreadyRunning = false;
    for (var h = 0; h < asynchronousHelpers.length; h++) {
        var helper = asynchronousHelpers[h];
        if (helper.isLaunched)
            continue;
        var scriptName = helper.name;
        if (isAnyServerRunning(scriptName)) {
            helper.isLaunched = true;
            continue;
        } else {
            var tool = getTool(helper.shortName);
            helper.isLaunched = await arbitraryExecution(ns, tool, 1, []);
            if (helper.isLaunched) {
                ns.print("Server " + whichServerIsRunning(scriptName) + " running " + scriptName);
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

async function doTargetingLoop(ns) {
    var isHelperListLaunched = false;
    while (true) {
        // sort the array so that already weakened servers have a high priority
        // while still taking their value into account
        sortServerList("money");
        
        // purchase as many servers with 1 TB as affordable, for extra umph.
        // I do this first for no real reason.
        detectChangesInDaemonHosts(ns);
        
        // run some auxilliary processes that ease the ram burden of this daemon
        // and add additional functionality (like managing hacknet or buying servers)
        if (!isHelperListLaunched) {            
            isHelperListLaunched = await runStartupScripts(ns);
        }
        
        var currentTargets = 0;
        // check for servers that need to be rooted
        // simultaneously compare our current target to potential targets     
        for (var i = 0; i < serverListMoney.length; i++) {            
            var server = serverListMoney[i];
            // check if we have root - make sure we're doing this before we skip for max Money of 0
            if (!server.hasRoot()) {
                // if we don't, and we can, get it.
                if (server.canCrack()) {
                    doRoot(server);
                }
            }
            if (server.maxMoney === 0) {
                continue;
            }
            // assume perhaps we just succeeded root
            if (currentTargets < maxTargets && server.hasRoot() && server.canHack() && server.shouldHack()) {
                // now don't do anything to it until prep finishes, because it is in a resting state.
                if (server.isPrepping())
                    continue;
                    
                // increment the target counter, consider this an optimal target
                currentTargets++;
                
                // if the target is in a resting state (we have scripts running against it), proceed to the next target.
                if (server.isTargeting())
                    continue;
                    
                // perform weakening and initial growth until the server is "perfected"
                await prepServer(ns, server);
                
                // the server isn't optimized, this means we're out of ram from a more optimal target, fuck off
                if (server.security() > server.minSecurity || server.money() < server.maxMoney)
                    continue;
                
                // now don't do anything to it until prep finishes, because it is in a resting state.
                if (server.isPrepping())
                    continue;
                
                // adjust the percentage to steal until it's able to rapid fire as many as it can
                await optimizePerformanceMetrics(ns, server);
                
                // once conditions are optimal, fire barrage after barrage of cycles in a schedule
                await performScheduling(ns, server);
            }   
        }          
        
        await ns.sleep(1000);
    }
}

function establishMultipliers(ns) {
    // uncomment this at SF-5 to handle your bitnode multipliers for you
    bitnodeMults = ns.getBitNodeMultipliers();
    
    // prior to SF-5, bitnodeMults stays null and these mults are set to 1.
    // annoyingly, right after BN1, you need to set these to 1.16 manually, and if 
    // you keep progressing, you have to update them. Just use your math skills and list of SFs to figure this out.
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
    var toolNames = ["weak-target.ns", "grow-target.ns", "hack-target.ns", "host-manager.ns", "node-manager.ns", "tor-manager.ns", "program-manager.ns", "ram-manager.ns", "agency-manager.ns", "aug-manager.ns"];
    for (var i = 0; i < toolNames.length; i++) {
        var tool = {
            instance: ns,
            name: toolNames[i],
            cost: ns.getScriptRam(toolNames[i], daemonHost),
            // I like short names. 
            shortName: function() {
                switch (this.name) {
                    case "weak-target.ns":
                        return "weak";
                    case "grow-target.ns":
                        return "grow";
                    case "hack-target.ns":
                        return "hack";
                    case "host-manager.ns":
                        return "host";
                    case "node-manager.ns":
                        return "node";
                    case "tor-manager.ns":
                        return "tor";
                    case "program-manager.ns":
                        return "prog";
                    case "ram-manager.ns":
                        return "ram";
                    case "agency-manager.ns":
                        return "agent";
                    case "aug-manager.ns":
                        return "aug";
                }
            },       
            canRun: function(server) {
                return doesServerHaveFile(this.instance, this.name, server.name) && server.ramAvailable() >= this.cost;
            },
            isThreadSpreadingAllowed: function() { return this.shortName() === "weak"; },
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
    return ns.fileExists(fileName, serverName);
}

// assemble a list of port crackers and abstract their functionality
function buildPortCrackingArray(ns) {
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
            switch(this.name) {
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
    var purchasedServers = ns.getPurchasedServers();
    for(var p = 0; p < purchasedServers.length; p++) {
        var hostName = purchasedServers[p];
        if (addedServers.includes(hostName))
            continue;
        addServer(buildServerObject(ns, hostName));
    }
    // get this - it goes the other direction too. :|
    // the host manager is cultivating better boxes asynchronously, which sometimes desyncs these datasets.
    // in particular, the ram dataset. To ensure that we're not continuously *blind* to servers that once existed,
    // but were scuttled for a better daemon, we have to term "lost" daemons as soon as it happens so we don't accidentally
    // try to run scripts on them (which bombs the daemon.js script).
    var removedHosts = [];
    addedServers.forEach(s => {
        if (s.startsWith("daemon")) {
            if (!purchasedServers.includes(s)) {
                removedHosts.push(s);
            }
        }
    });
    removedHosts.forEach(r => {
        var serverListMoneyIndex = serverListMoney.map(function(s) { return s.name }).indexOf(r);
        var serverListRamIndex = serverListRam.map(function(s) { return s.name }).indexOf(r);
        var addedServersIndex = addedServers.indexOf(r);
        if (serverListMoneyIndex !== -1) {
            serverListMoney.splice(serverListMoneyIndex, 1);
        }
        if (serverListRamIndex !== -1) {
            serverListRam.splice(serverListRamIndex, 1);
        }
        if (addedServersIndex !== -1) {
            addedServers.splice(addedServersIndex, 1);
        }
    });
}

function sortServerList(o) {
    switch (o) {
        case "ram":
            serverListRam.sort(function (a, b) { return b.ramAvailable() - a.ramAvailable(); });
            break;
        case "money":
            serverListMoney.sort(function (a, b) { return b.sortValue() - a.sortValue(); });
            break;
    }
}

// return the adjustment quantity based on current performance metrics
// -1 adjusts down, 1 adjusts up, 0 means don't do anything.
function analyzeSnapshot(snapshot, currentTarget) {
    // always overshoot the target. this is the priority.
    if (snapshot.maxCompleteCycles() < snapshot.optimalPacedCycles && currentTarget.percentageToSteal > 0.01) {
        return -0.01;
    } else if (snapshot.maxCompleteCycles() > snapshot.optimalPacedCycles && currentTarget.percentageToSteal < 0.98) {
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
        maxCompleteCycles: function() {
            // total number of cycles is the max you can fit inside any single daemon host, summed
            var maxCycles = 0;
            // we have to sort by available ram any time we're trying to execute.. because it changes.
            sortServerList("ram");            
            for (var i = 0; i < serverListRam.length; i++) {
                var daemonServer = serverListRam[i];
                maxCycles += Math.floor(daemonServer.ramAvailable() / this.optimalBatchCost);
            }
            return maxCycles;
        },
        optimalPacedCycles: Math.min(maxBatches, Math.max(1, Math.floor((currentTarget.timeToWeaken() - queueDelay) / arbitraryExecutionDelay)))
    };
    return snapshot;
}

async function optimizePerformanceMetrics(ns, currentTarget) {
    var isOptimal = false;
    var hasChanged = false;
    while (!isOptimal) {
        var snapshot = getPerformanceSnapshot(currentTarget);
        var adjustment = analyzeSnapshot(snapshot, currentTarget);
        if (adjustment === 0.00) {
            isOptimal = true;
        } else {
            hasChanged = true;
            currentTarget.percentageToSteal += adjustment;
        }
        await ns.sleep(10);
    }
    if (hasChanged) {        
        ns.print("Tuning optimum threading on " + currentTarget.name + ", percentage: " + (Math.floor(currentTarget.actualPercentageToSteal() * 10000) / 100));
    }
}

function getOptimalBatchCost(currentTarget) {
    var weakenTool = getTool("weak");
    var growTool = getTool("grow");
    var hackTool = getTool("hack");
    var weakenCost =  currentTarget.weakenThreadTotalPerCycle() * weakenTool.cost;
    var growCost = currentTarget.growThreadsNeededAfterTheft() * growTool.cost;
    var hackCost = currentTarget.hackThreadsNeeded() * hackTool.cost;
    var totalCost = weakenCost + growCost + hackCost;
    return totalCost;
}

async function performScheduling(ns, currentTarget) {    
    var firstEnding = null;    
    var lastStart = null;
    var scheduledTasks = [];
    var canSchedule = scheduledTasks.length === 0;
    if (!canSchedule)
        return;
    var snapshot = getPerformanceSnapshot(currentTarget);
    var maxCycles = Math.min(snapshot.optimalPacedCycles, snapshot.maxCompleteCycles());
    var cyclesScheduled = 0;
    var now = new Date(Date.now() + queueDelay);        
    var lastBatch = 0;
    
    ns.print("Scheduling " + currentTarget.name + ", batches: " + maxCycles + " - anticipating an estimated " + Math.floor(currentTarget.timeToWeaken() * 2) + " second delay.");
    while (canSchedule) {        
        var newBatchStart = (scheduledTasks.length === 0) ? now : new Date(lastBatch.getTime() + arbitraryExecutionDelay);
        lastBatch = new Date(newBatchStart.getTime());
        var newBatch = getScheduleTiming(ns, newBatchStart, currentTarget, scheduledTasks.length);      
        if (firstEnding === null) {            
            firstEnding = new Date(newBatch.hackEnd.valueOf());
        }        
        if (lastStart === null || lastStart < newBatch.firstFire) {
            lastStart = new Date(newBatch.firstFire.valueOf());
        }        
        if (lastStart >= firstEnding) {
            canSchedule = false;
        }        
        if (!canSchedule)
            break;
        scheduledTasks.push(newBatch);
        cyclesScheduled++;
        if (cyclesScheduled >= maxCycles)
            break;
        await ns.sleep(10);
    }
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
                        executionTime = currentTarget.timeToHack();
                        break;
                    case "grow":
                        executionTime = currentTarget.timeToGrow();
                        break;
                    case "weak":
                        executionTime = currentTarget.timeToWeaken();
                        break;
                }
                await arbitraryExecution(ns, tool, threads, [currentTarget.name, schedItem.start.getTime(), schedItem.end.getTime(), executionTime, discriminationArg]);
            }
        }
    }
}

// returns an object that contains all 4 timed events start and end times as dates
function getScheduleTiming(ns, fromDate, currentTarget, batchNumber) {
    // spacing interval used to pace our script resolution
    var delayInterval = arbitraryExecutionDelay / 4;
    
    // first to fire
    var hackTime = currentTarget.timeToHack();
    
    // second to fire
    var weakenTime = currentTarget.timeToWeaken();
    
    // third to fire
    var growTime = currentTarget.timeToGrow();
    
    // fourth to fire, we apply the interval here
    var weakenSecondTime = currentTarget.timeToWeaken() + delayInterval * 3;
    
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
    fireHackAt.setTime(fireHackAt.getTime() - hackTime);
    
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
        if (tools[i].shortName() == s) {
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
    for (var i = 0; i < serverListRam.length; i++) {
        // we've done it, move on.
        if (threads <= 0)
            break;
        var sourceServer = serverListRam[i];
        // if we don't have root, we don't have exec privileges, move on.
        if (!sourceServer.hasRoot())
            continue;
        var maxThreadsHere = Math.min(threads, Math.floor(sourceServer.ramAvailable() / tool.cost));
        if (maxThreadsHere <= 0)
            continue;
        threads -= maxThreadsHere;
        // if we're coming from the daemon host, we can use run
        if (sourceServer.name == daemonHost) {
            var runArgs = [tool.name, maxThreadsHere].concat(args);
            await ns.run.apply(null, runArgs);
            return true;
        } else {
            // if not, we use a remote execute, with a script copy check.
            if (!doesServerHaveFile(ns, tool.name, sourceServer.name)) {
                await ns.scp(tool.name, daemonHost, sourceServer.name);
            }
            var execArgs = [tool.name, sourceServer.name, maxThreadsHere].concat(args);
            await ns.exec.apply(null, execArgs);
            return true;
        }
    }
    // the run failed!
    return false;
}

// brings the server down to minimum security to prepare for cycling scheduler activity
async function prepServer(ns, currentTarget) {
    // once we're in scheduling mode, presume prep server is to be skipped.
    if (currentTarget.isTargeting())
        return;    
    var now = new Date(Date.now().valueOf());
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
        var threadSleep = currentTarget.timeToWeaken() + queueDelay;
        var threadsAllowable = weakenTool.getMaxThreads();        
        var trueThreads = Math.min(threadsAllowable, threadsNeeded);
        if (trueThreads > 0) {
            ns.print("Prepping " + currentTarget.name + ", resting for " + Math.floor(threadSleep / 1000) + " seconds.");
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
            if (this.maxMoney === 0) {
                return 0;
            }
            // if the server is at base security, prioritize it.
            // we do this by pretending the time to weaken is really really small.
            var timeToWeakenVar = this.timeToWeaken();
            if (this.security() > this.minSecurity) {
                timeToWeakenVar = 1;
            }
            return this.maxMoney / (timeToWeakenVar * 2); },
        canCrack: function() { return getPortCrackers(this.instance) >= this.portsRequired },
        canHack: function() { return this.hackingRequired <= this.instance.getHackingLevel(); },
        shouldHack: function () { return this.maxMoney > 0 && this.name !== "home" && !this.instance.getPurchasedServers().includes(this.name); },
        money: function() { return this.instance.getServerMoneyAvailable(this.name); },
        security: function() { return this.instance.getServerSecurityLevel(this.name); },
        isPrepping: function() {
            var toolNames = ["weak-target.ns", "grow-target.ns", "hack-target.ns"];
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
            var toolNames = ["weak-target.ns", "grow-target.ns", "hack-target.ns"];
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
            return (this.instance.getHackingLevel() - (this.hackingRequired - 1)) / this.instance.getHackingLevel();
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
        getRam: function() { return this.instance.getServerRam(this.name); },
        ramAvailable: function() { 
            var ramArray = this.getRam(); 
            return ramArray[0] - ramArray[1];
        },
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
    schedItems.push(schedItem1);
    schedItems.push(schedItem2);
    schedItems.push(schedItem3);
    
    var scheduleObject = {
        batchNumber: batchNumber,
        batchStart: batchTiming.batchStart,
        firstFire: batchTiming.firstFire,
        hackEnd: batchTiming.hackEnd,
        batchFinish: schedItem3.end,
        scheduleItems: schedItems
    };
    
    return scheduleObject;
}

function addServer(server) {
    serverListRam.push(server);
    serverListMoney.push(server);
    addedServers.push(server.name);
}

function getPortCrackers(ns) {
    var count = 0;
    for(var i = 0; i < portCrackers.length; i++) {
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
