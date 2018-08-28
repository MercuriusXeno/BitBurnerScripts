export async function main(ns) {
    const neuroFlux = "NeuroFlux Governor";
    var desiredFactions = getDesiredFactions(ns);
    var currentFaction = "";
    while (true) {
        var info = ns.getCharacterInformation();
        var factions = info.factions;
        if (factions.length === 0) {
            await ns.sleep(5000);
            continue;
        }
            
        // loop over all our desirable factions
        for(var d in desiredFactions) {
            var faction = desiredFactions[d];
            if (ns.isBusy()) {
                continue;
            }
            // if we're a member of this faction
            if (factions.includes(faction.name)) {
                var hasAllFactionAugs = true;
                var augsAlreadyInstalled = true;
                var factionAugs = ns.getAugmentationsFromFaction(faction.name);
                // we're at a place with this faction where we need to just donate.
                // we do this if we're missing augs or not. It's much faster to just hit 150 favor and donate.
                if (ns.getFactionFavor(faction.name) + ns.getFactionFavorGain(faction.name) >= 150 && ns.getFactionFavor(faction.name) < 150) {
                    while (ns.getAugmentationCost(neuroFlux)[1] <= ns.getServerMoneyAvailable("home") && ns.getAugmentationCost(neuroFlux)[0] <= ns.getFactionRep(faction.name)) {
                        ns.purchaseAugmentation(faction.name, neuroFlux);
                        ns.tprint("Purchasing aug from " + faction.name + ": " + neuroFlux);
                        await ns.sleep(100);
                    }
                    if (ns.getOwnedAugmentations(true).length > ns.getOwnedAugmentations(false).length) {
                        ns.installAugmentations("daemon.ns");
                    }   
                }
                
                // and we don't own all of the augmentations already
                for (var a in factionAugs) {
                    var aug = factionAugs[a];
                    // skip neuroflux, we don't want to work too hard for it.
                    if (aug === neuroFlux) {
                        continue;
                    }
                    if (!ns.getOwnedAugmentations(true).includes(aug)) {
                        hasAllFactionAugs = false;
                        var augCost = ns.getAugmentationCost(aug);
                        var repCost = augCost[0];
                        var cashCost = augCost[1];
                        if (repCost <= ns.getFactionRep(faction.name)) {
                            if (cashCost <= ns.getServerMoneyAvailable("home")) {
                                ns.purchaseAugmentation(faction.name, aug);
                                ns.tprint("Purchasing aug from " + faction.name + ": " + aug);
                            }
                        } else {
                            // we don't have enough rep for this faction so let's work until we do.
                            // we skip this if our favor is high enough to donate.
                            while (ns.getFactionRep(faction.name) < repCost && ns.getFactionFavor(faction.name) < 150) {
                                ns.workForFaction(faction.name, "hacking");
                                await ns.sleep(30000);
                            }
                            ns.stopAction();
                        }
                    } else {
                        augsAlreadyInstalled = false;
                    }
                }
                
                // we have all the augs but they're not installed yet
                if (hasAllFactionAugs && !augsAlreadyInstalled) {
                    while (ns.getAugmentationCost(neuroFlux)[1] <= ns.getServerMoneyAvailable("home") && ns.getAugmentationCost(neuroFlux)[0] <= ns.getFactionRep(faction.name)) {
                        ns.purchaseAugmentation(faction.name, neuroFlux);
                        ns.tprint("Purchasing aug from " + faction.name + ": " + neuroFlux);
                        await ns.sleep(100);
                    }
                    if (ns.getOwnedAugmentations(true).length > ns.getOwnedAugmentations(false).length) {
                        ns.installAugmentations("daemon.ns");
                    }
                }
            }
        }
        
        await ns.sleep(1000);
    }
}

function getDesiredFactions(ns) {
    var factionList = [
        {name:"Sector-12"}, 
        {name:"Netburners"}, 
        {name:"CyberSec"}, 
        {name:"NiteSec"}, 
        {name:"The Black Hand"}, 
        {name:"BitRunners"}, 
        {name:"Daedalus"}
    ];
    return factionList;
}