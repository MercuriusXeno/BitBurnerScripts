// the purpose of hack-target is to wait until an appointed time and then execute a hack.

export async function main(ns) {
    await ns.sleep(parseInt(ns.args[1]) - Date.now());
    await ns.hack(ns.args[0]);
}
