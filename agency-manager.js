// the purpose of the agency manager is simply to join factions when they become available.

export async function main(ns) {
    const desiredFactions = ["Sector-12", "Netburners", "CyberSec", "NiteSec", "The Black Hand", "BitRunners", "Daedalus"];
    var allFactionsJoined = false;
    while (!allFactionsJoined) {
        var invites = ns.checkFactionInvitations();
        for(var i in invites) {
            ns.joinFaction(invites[i])
        }
        // check if we're already a member of all the factions we want to be in
        var factionsJoinedCheck = true;
        var info = ns.getCharacterInformation();
        var alreadyInFactions = info.factions;
        for(var d in desiredFactions) {
            if (!alreadyInFactions.includes(d)) {
                factionsJoinedCheck = false;
            }
        }
        
        if (factionsJoinedCheck) {
            allFactionsJoined = true;
        }
        await ns.sleep(1000);
    }
}