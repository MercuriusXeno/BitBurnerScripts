// the purpose of the program-manager is to buy all the programs
// from the darkweb we can afford so we don't have to do it manually
// or write them ourselves. Like tor-manager, this script dies a natural death
// once all programs are bought.

export async function main(ns) {
    const programNames = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe", "DeepscanV1.exe", "DeepscanV2.exe", "Autolink.exe"];
    const programCosts = [500000, 1500000, 5000000, 30000000, 250000000, 500000, 25000000, 1000000];
    var hasAllPrograms = false;
    while (true) {
        if (hasAllPrograms) {
            break;
        }
        if (!hasTor(ns)) {
            await ns.sleep(2000);
            continue;
        }
        var foundMissingProgram = false;
        for (var i = 0; i < programNames.length; ++i) {
            var prog = programNames[i];
            if (hasProgram(ns, prog)) {
                continue;
            } else {
                foundMissingProgram = true;
            }
            var cost = programCosts[i];
            if (cost <= getPlayerMoney(ns)) {
                ns.purchaseProgram(prog);
            }
        }
        if (!foundMissingProgram) {
            hasAllPrograms = true;
        }
        await ns.sleep(2000);
    }
}

function getPlayerMoney(ns) {
    return ns.getServerMoneyAvailable("home");
}

function hasProgram(ns, program) {
    return ns.fileExists(program, "home");
}

function hasTor(ns) {
    var homeNodes = ns.scan("home");
    return homeNodes.includes("darkweb");
}
