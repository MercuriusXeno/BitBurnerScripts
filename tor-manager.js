// the purpose of tor-manager is to buy the TOR router ASAP
// so that another script can buy the port breakers. This script
// dies a natural death once tor is bought.

export async function main(ns) {
    const torCost = 200000;
    var hasTorRouter = false;
    while (true) {
        if (hasTorRouter) {
            break;
        }
        if (hasTor(ns)) {
            hasTorRouter = true;
        } else {
            if (torCost <= getPlayerMoney(ns)) {
                ns.purchaseTor();
            }
        }
        await ns.sleep(200);
    }
}

function getPlayerMoney(ns) {
    return ns.getServerMoneyAvailable("home");
}

function hasTor(ns) {
    var homeNodes = ns.scan("home");
    return homeNodes.includes("darkweb");
}