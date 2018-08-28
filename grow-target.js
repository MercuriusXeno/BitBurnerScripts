// the purpose of grow-target is to wait until an appointed time and then execute a grow.

export async function main(ns) {
    await ns.sleep(parseInt(ns.args[1]) - Date.now());
    await ns.grow(ns.args[0]);
}
