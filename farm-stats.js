const ramCostConstant = 55000;

// the purpose of this script is to return a list of our server farm capabilities
export async function main(ns) {
    var serverNameList = ns.getPurchasedServers();
    ns.tprint("--==-- Server Farm Stats --==--");
    for (var s = 0; s < serverNameList.length; s++) {
        var box = serverNameList[s];
        var ram = ns.getServerRam(box);
        var maxRam = ram[0];
        var currentRam = ram[0] - ram[1];
        var cost = maxRam * ramCostConstant;
        ns.tprint(box + " Ram: " + currentRam + " / " + maxRam + " --==-- Cost: $" + cost);
    }
}
