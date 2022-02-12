// The purpose of the host manager is to buy the best servers it can
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
// Keep at least this much money on hand (so we arent blocked from buying necessary things)
const reservedMoney = 250000000;

// If set to false, we will keep buying better servers and deleting older ones once at max capacity.
var stopAtMax = true;
var cachedNs = null;

export async function main(ns) {
    ns.disableLog('ALL')
    cachedNs = ns;

    if (ns.args.length > 0 && ns.args[0] == '-f')
        stopAtMax = false;
    while (true) {
        tryToBuyBestServerPossible(ns);
        await ns.sleep(5000);
    }
}

function formatMoney(num) {
    let symbols = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc"];
    let i = 0;
    for (;
        (num >= 1000) && (i < symbols.length); i++) num /= 1000;
    return ((Math.sign(num) < 0) ? "-$" : "$") + num.toFixed(3) + symbols[i];
}

var lastStatus = "";

function setStatus(log) {
    if (log != lastStatus)
        cachedNs.print(lastStatus = log);
    return log;
}

function announce(log) {
    cachedNs.print(log);
    cachedNs.tprint(log);
}

// attempts to buy a server at or better than your home machine.
function tryToBuyBestServerPossible(ns) {
    var currentMoney = ns.getServerMoneyAvailable("home");

    var exponentLevel = 1;
    while (Math.pow(2, exponentLevel + 1) * purchasedServerCostPerRam <= currentMoney && exponentLevel < maxPurchasedServerRamExponent) {
        exponentLevel += 1;
    }

    // if the server is crappier than home don't bother.
    var maxRamPossibleToBuy = Math.pow(2, exponentLevel);
    var homeUtilization = ns.getServerRam("home")

    // Get a list of purchased servers
    var purchasedServers = ns.getPurchasedServers();
    var existingServers = purchasedServers.slice();
    var ignoredServers = [];

    // Add 'free' servers we get from hacked nodes
    var hostsToScan = [];
    hostsToScan.push("home");
    var infLoopProtection = 1000;
    while (hostsToScan.length > 0 && infLoopProtection-- > 0) {
        var hostName = hostsToScan.pop();
        //ns.print('Check ' + hostName);
        if (existingServers.includes(hostName) || ignoredServers.includes(hostName))
            continue;
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
    if (infLoopProtection <= 0) announce('host-manager.js Infinite Loop Detected!');

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
    setStatus('Utilization is ' + Math.round(utilizationTotal).toLocaleString() + ' GB of ' + Math.round(ramMax).toLocaleString() + ' GB (' +
        (utilizationRate * 100).toFixed(1) + '%) across ' + existingServers.length + ' servers.')

    // Stop if utilization is below target. We probably don't need another server.
    if (utilizationRate < utilizationTarget)
        return;

    var prefix = 'Host-manager wants to buy another server, but ';
    // Abort if we've hit the maximum number of purchasable servers and are configured to stop at max
    if (stopAtMax && purchasedServers.length >= maxPurchasedServers)
        return setStatus(prefix + 'purchasedServers count (' + purchasedServers.length + ') is at maximum ' + maxPurchasedServers + ')');
    // Abort if our home server is bettter
    if (maxRamPossibleToBuy < homeUtilization[0] && maxRamPossibleToBuy < Math.pow(2, maxPurchasedServerRamExponent))
        return setStatus(prefix + 'maxRamPossibleToBuy (' + maxRamPossibleToBuy.toLocaleString() + ' GB) is less than home ram ' +
            Math.round(homeUtilization[0]).toLocaleString() + ' GB)');
    // Abort if our worst server is better.
    if (isWorseThanExistingServer)
        return setStatus(prefix + 'best server we can buy RAM (' + Math.round(maxRamPossibleToBuy).toLocaleString() +
            ' GB) is less than worst existing server RAM (' + worstServer + " with " + Math.round(worstServerRam).toLocaleString() + ' GB)');
    // Abort if we don't have enough money
    if (currentMoney <= reservedMoney)
        return setStatus(prefix + 'currentMoney (' + formatMoney(currentMoney) + ') is less than reserved money (' + formatMoney(reservedMoney) + ')');
    // Abort if it would put us below our reserve
    var cost = maxRamPossibleToBuy * purchasedServerCostPerRam;
    if (currentMoney < cost || (currentMoney - cost) < reservedMoney)
        return setStatus(prefix + 'currentMoney (' + formatMoney(currentMoney) + ') less cost (' + formatMoney(cost) +
            ') is less than reserved money (' + formatMoney(reservedMoney) + ')');

    // if we're at capacity, check to see if we're better than the worst server, then delete it.
    if (purchasedServers.length >= maxPurchasedServers) {
        var listOfScripts = ns.ps(worstServer);
        if (listOfScripts.length === 0 && worstServerRam < maxRamPossibleToBuy) {
            if (stopAtMax)
                return setStatus('hostmanager.js wants to delete server ' + worstServer + ' to make room for a better one, but deleting servers is disabled.');
            else {
                ns.deleteServer(worstServer);
                announce('hostmanager.js deleted server ' + worstServer + ' to make room for a better one.');
            }
        }
    }

    var purchasedServer = ns.purchaseServer("daemon", maxRamPossibleToBuy);
    announce('Purchased a new server ' + purchasedServer + ' with ' + maxRamPossibleToBuy.toLocaleString() + ' GB RAM for ' + formatMoney(cost));
}
