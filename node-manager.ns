var allowancePercentage = 0.00001;

export async function main(ns) {
    buildNodeLibrary(ns);
    ns.purchaseHacknetNode();
    while(true) {
        nodeLibrary.doLoop();
        await ns.sleep(1000);
    }
}


var nodeLibrary = null;

function buildNodeLibrary(ns) {
    nodeLibrary = 
    {
        instance: ns,
        nodes: function() { return this.instance.hacknetnodes },
        options: ["level", "ram", "core", "node"],
        getCost: function(option, nodeIndex) {
            switch(option) {
                case 0:
                    return this.nodes()[nodeIndex].getLevelUpgradeCost(1);
                case 1:
                    return this.nodes()[nodeIndex].getRamUpgradeCost();
                case 2:
                    return this.nodes()[nodeIndex].getCoreUpgradeCost();
                case 3:
                    return this.instance.getNextHacknetNodeCost();
            }
        },
        buyThing: function(option, nodeIndex) {
            switch(option) {
                case 0:
                    this.nodes()[nodeIndex].upgradeLevel(1);
                    break;
                case 1:
                    this.nodes()[nodeIndex].upgradeRam();
                    break;
                case 2:
                    this.nodes()[nodeIndex].upgradeCore();
                    break;
                case 3:
                    this.instance.purchaseHacknetNode()
                    break;
            }  
        },
        playerMoney: function() { return this.instance.getServerMoneyAvailable("home"); },
        shouldPurchase: function(option, nodeIndex) {
            return this.playerMoney() * allowancePercentage >= this.getCost(option, nodeIndex);    
        },
        doLoop: function() {
            for (var i = 0; i < this.nodes().length; i++) {
                for (var o = 0; o < this.options.length; o++) {
                    if (this.shouldPurchase(o, i))
                        this.buyThing(o, i);
                }
            }
        }
    }
}
