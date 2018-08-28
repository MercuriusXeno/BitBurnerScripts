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

export async function main(ns) {
    while(true) {
        tryToBuyBestServerPossible(ns);
        await ns.sleep(200);
    }
}

// buy a mess of servers
async function buyDaemonHosts(ns) {
    while(tryToBuyBestServerPossible(ns) !== "") {
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
    while(Math.pow(2, exponentLevel + 1) * purchasedServerCostPerRam <= currentMoney && exponentLevel < maxPurchasedServerRamExponent) {
        exponentLevel += 1;
    }
    
    // if the server is crappier than home don't bother.
    var maxRamPossibleToBuy = Math.pow(2, exponentLevel);
    if (maxRamPossibleToBuy < ns.getServerRam("home")[0] && maxRamPossibleToBuy < Math.pow(2, maxPurchasedServerRamExponent) ) {
        return "";
    }
    
    // check to make sure we have room in our server farm.
    var existingServers = ns.getPurchasedServers();
      
    // determine ram utilization rates
    var homeUtilization = ns.getServerRam("home");
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
    
    // hard coded ballpark, if we're over this percentage, consider us "well utilized".
    var utilizationTarget = 0.5;
    
    // abort if utilization is below target. We probably don't need another server.
    if (utilizationRate < utilizationTarget)
        return "";
    
    // abort if we're trying to buy a sucky box.
    if (isWorseThanExistingServer)
        return "";
    
    // if we're at capacity, check to see if we're better than the worst server, then delete it.
    if (existingServers.length >= maxPurchasedServers) {
        var listOfScripts = ns.ps(worstServer);
        if (listOfScripts.length === 0 && worstServerRam < maxRamPossibleToBuy) {
            ns.deleteServer(worstServer);
        }
    }
    
    var cost = maxRamPossibleToBuy * purchasedServerCostPerRam;
    
    // you're too poor lol
    if (currentMoney < cost)
        return "";
    
    var purchasedServer = ns.purchaseServer("daemon", maxRamPossibleToBuy);
    
    return purchasedServer;
}