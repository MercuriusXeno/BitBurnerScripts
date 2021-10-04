// the purpose of the host manager is to buy the best servers it can
// until it thinks RAM is underutilized enough that you don't need to anymore.

// the max server ram you can buy (it's a petabyte)
const maxPurchasedServerRam = 1048576;

// the amount of money each gig costs when you buy a server.
const purchasedServerCostPerRam = 55000;

// the max amount of server ram as an exponent (power of 2)
const maxPurchasedServerRamExponent = 20;

// the max number of servers you can have in your farm
const maxPurchasedServers = 25;

// Don't attempt to buy any new servers if we're under this utilization
const utilizationTarget = 0.95;

// If set to false, we will keep buying better servers and deleting older ones once at max capacity.
var stopAtMax = true;

// Keep at least this much money on hand (so we arent blocked from buying necessary things)
const reservedMoney = 250000000;

export async function main(ns) {
    if (ns.args.length > 0 && ns.args[0] == '-f')
        stopAtMax = false;
    while (true) {
        // if we're at capacity, don't buy any more servers
        //var ownedServers = ns.getPurchasedServers().length;
        //if (stopAtMax && ownedServers >= maxPurchasedServers) {
        //    ns.print(ownedServers + ' servers owned. Shutting down...')
        //    return "";
        //}
        tryToBuyBestServerPossible(ns);
        await ns.sleep(5000);
    }
}

// buy a mess of servers
async function buyDaemonHosts(ns) {
    while (tryToBuyBestServerPossible(ns) !== "") {
        // NOOP
        await ns.sleep(200);
    }
}

function getMyMoney(ns) {
    return ns.getServerMoneyAvailable("home");
}

// attempts to buy a server at or better than your home machine.
function tryToBuyBestServerPossible(ns) {
    var currentMoney = getMyMoney(ns);
    
    var exponentLevel = 1;
    while (Math.pow(2, exponentLevel + 1) * purchasedServerCostPerRam <= currentMoney && exponentLevel < maxPurchasedServerRamExponent) {
        exponentLevel += 1;
    }
    
    // if the server is crappier than home don't bother.
    var maxRamPossibleToBuy = Math.pow(2, exponentLevel);
    var homeUtilization = ns.getServerRam("home")
    
    // Get a list of purchased servers
    var existingServers = ns.getPurchasedServers();
    var ignoredServers = [];
    
    // Add 'free' servers we get from hacked nodes
    var hostsToScan = [];
    hostsToScan.push("home");
    while (hostsToScan.length > 0) {
        var hostName = hostsToScan.pop();
        if (!existingServers.includes(hostName)) {
            var connectedHosts = ns.scan(hostName);
            for (var i = 0; i < connectedHosts.length; i++) {
                hostsToScan.push(connectedHosts[i]);
            }
            // Home tracked and handled separately
            if (hostName == 'home')
                continue;
            // Only include hacked servers with usable RAM
            if (ns.getServerRam(hostName)[0] >= 0 && ns.hasRootAccess(hostName))
                existingServers.push(hostName);
            else
                ignoredServers.push(hostName);
        }
    }
    
    // determine ram utilization rates
    var utilizationTotal = homeUtilization[1];
    var ramMax = homeUtilization[0];
    
    // used to track the worst server in our list.
    var worstServer = "";
    
    // arbitrarily the max value
    var worstServerRam = Math.pow(2, maxPurchasedServerRamExponent);
    
    var isWorseThanExistingServer = false;
    
    // iterate over the server farm to see if there's any opportunity for improvement
    for (var i = 0; i < existingServers.length; i++) {
        var existingServer = existingServers[i];
    
        // track the worst server in the farm
        var ramStats = ns.getServerRam(existingServer);
        var existingServerRam = ramStats[0];
        var utilization = ramStats[1];
        utilizationTotal += utilization;
        ramMax += existingServerRam;
        if (existingServerRam < worstServerRam) {
            worstServer = existingServer;
            worstServerRam = existingServerRam;
        }
    
        // if the server is crappier than an existing server don't bother.
        if (maxRamPossibleToBuy < existingServerRam) {
            isWorseThanExistingServer = true;
        }
    }
    
    // analyze the utilization rates
    var utilizationRate = utilizationTotal / ramMax;
    ns.print('Servers utilization is ' + utilizationTotal.toLocaleString() + ' GB of ' + ramMax.toLocaleString() + ' GB (' + (utilizationRate * 100).toFixed(2) + '%) across ' + existingServers.length + ' rooted servers.')
    
    // abort if utilization is below target. We probably don't need another server.
    if (utilizationRate < utilizationTarget)
        return "";
    ns.print('hostmanager.js wants to buy another server.')
    
    if (stopAtMax && existingServers.length >= maxPurchasedServers) {
        ns.print('existingServers count (' + existingServers.length + ') is at maximum ' + maxPurchasedServers + ')')
        return "";
    }
    // Abort if our home server is bettter/
    if (maxRamPossibleToBuy < homeUtilization[0] && maxRamPossibleToBuy < Math.pow(2, maxPurchasedServerRamExponent)) {
        ns.print('maxRamPossibleToBuy (' + maxRamPossibleToBuy.toLocaleString() + ') is less than home ram ' + homeUtilization[0].toLocaleString() + ')')
        return "";
    }
    // Abort if our worst server is better.
    if (isWorseThanExistingServer) {
        ns.print('Best server we can buy RAM (' + maxRamPossibleToBuy.toLocaleString() + ') is less than worst existing server RAM (' + worstServer + ": " + worstServerRam.toLocaleString() + ')')
        return "";
    }
    // Abort if we don't have enough money
    if (currentMoney <= reservedMoney) {
        ns.print('currentMoney (' + currentMoney.toLocaleString() + ') is less than reserved money (' + reservedMoney.toLocaleString() + ')')
        return "";
    }
    // Abort if it would put us below our reserve
    var cost = maxRamPossibleToBuy * purchasedServerCostPerRam;
    if (currentMoney < cost || (currentMoney - cost) < reservedMoney) {
        ns.print('currentMoney (' + currentMoney.toLocaleString() + ') less cost (' + cost.toLocaleString() + ') is less than reserved money (' + reservedMoney.toLocaleString() + ')')
        return "";
    }
    
    // if we're at capacity, check to see if we're better than the worst server, then delete it.
    if (existingServers.length >= maxPurchasedServers) {
        var listOfScripts = ns.ps(worstServer);
        if (listOfScripts.length === 0 && worstServerRam < maxRamPossibleToBuy) {
            ns.print('hostmanager.js wants to delete server ' + worstServer + ' to make room for a better one.')
            if (stopAtMax)
                ns.print('Deleting servers is disabled.')
            else
                ns.deleteServer(worstServer);
        }
    }
    
    var purchasedServer = ns.purchaseServer("daemon", maxRamPossibleToBuy);
    
    return purchasedServer;
}
