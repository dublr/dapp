
import { get, set } from "idb-keyval";

window.DEBUG_IDB = false;

export async function idbGet(key, valOnFailure) {
    let val;
    try {
        val = await get(key);
    } catch (e) {
        console.log("IndexdDB isn't working:", e);
        val = valOnFailure;
    }
    if (window.DEBUG_IDB) {
        console.log("idbGet(" + key + ") = " + val);
    }
    return val;
}

export async function idbSet(key, val) {
    set(key, val).catch(e => {
        console.log("IndexdDB isn't working:", e);
    });
    if (window.DEBUG_IDB) {
        console.log("idbSet(" + key + ", " + val + ")");
    }
}

window.idbGet = idbGet;
window.idbSet = idbSet;

