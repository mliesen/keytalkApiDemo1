import kt from "keytalk-api";
import * as fs from "fs";
import Q from "q";
import { kStringMaxLength } from "buffer";
import { KeyLib } from "keytalk-api/dist/keyLib2";

interface ITag {
    tag :string;
    floatres?: string;
    poll?: string;
}

interface IDevice {
    url: string;
    user: string;
    password: string;
    tags: ITag[];
    filename: string;
    append: boolean;
}

interface IConfigFile {
    devices: IDevice[];
}

function date2string(d: Date): string {
    return kt.keyLib.DateTimeEx.dateTimeToString(d)
}
function value2string(v: kt.engine.IKeyTalkValue, fr?: kt.keyLib.FloatEx.IFloatFormat ): string {
    if(v.isValue() && fr && (v.typ==="SINGLE" || v.typ==="DOUBLE")) {
        return fr.convert(v.asNumber());
    }
    return v.v;
}

class Tag {
    private cfg:ITag;
    private device: Device;
    private fr?: kt.keyLib.FloatEx.IFloatFormat;
    private ci?: kt.engine.IKeyTalkClientItem;
    private lastNull:boolean=false;
    private lastErr: boolean = false;
    private isPoll: boolean = false;
    private pollInterv: number = 0;
    private pollLastVal: string|undefined=undefined;
    private pollLastErr: string|undefined=undefined;
    private pollNext: number=0;
    private writeDataToFile(v:kt.engine.IKeyTalkValue) {
        if (!this.device.stream)
            return;
        if((v.isNull() || v.isError()) &&  (v.isNull() === this.lastNull) && (v.isError()===this.lastErr))
            return;
        this.lastErr=v.isError();
        this.lastNull=v.isNull();
        let txt = `${date2string(new Date)}\t${this.cfg.tag}\t${v.typ}\t${value2string(v, this.fr)}`;
        this.device.stream.write(txt +"\r\n");
        let txt2 = `${date2string(new Date)}\t${this.device.cfg.filename}\t${this.cfg.tag}\t${v.typ}\t${value2string(v, this.fr)}`;
        console.log(txt2);
    }
    constructor(dev:Device,cfg:ITag) {
        this.cfg=cfg;
        this.device=dev;
        if(cfg.floatres)
            this.fr = kt.keyLib.FloatEx.floatFormat(cfg.floatres);
        if (cfg.poll) {
            this.pollInterv=KeyLib.TimeSpanEx.timeLenStr2msek(cfg.poll)
        }
        this.isPoll = this.pollInterv>0;
        this.pollNext = (new Date().valueOf());
    }
    public startSubscr() {
        if(!this.isPoll) {
            this.ci = this.device.eng.subscribe(this.cfg.tag, (ci, va) => {
                this.writeDataToFile(va);
            }, this.cfg.floatres);
        }
    }
    public endSubscr() {
        if (!this.isPoll) {
            if(this.ci)
                this.ci.cancel();
            this.ci=undefined;
        }
    }
    public doTimer(tic:number) {
        if(this.isPoll && (tic>=this.pollNext) && this.ci===undefined) {
            this.pollNext = this.pollNext + this.pollInterv;
            this.ci=this.device.eng.requestAsync(this.cfg.tag);
            this.ci.promise()
            .then(
                (v)=> {
                    if(v.error===this.pollLastErr && v.v===this.pollLastVal)
                        return;
                    this.pollLastErr=v.error;
                    this.pollLastVal=v.v;
                    this.writeDataToFile(v);
                },
                (err)=> {
                    console.log(" poll error: " + err);
                }
            )
            .catch(err=>{
                console.log(" poll exception: " + err);
            })
            .finally(()=> {
                this.ci = undefined;
           })
            ;
        }
    }
}

enum DeviceState {idle,connecting,startSubscr,running,fail,close,closed};

class Device {
    public eng: kt.engine.KeyTalkEngine;
    public stream?: fs.WriteStream;
    private state: DeviceState=DeviceState.idle;
    public cfg: IDevice;
    private tags: Tag[];
    private wantClose:boolean=false;
    private closedPromise:Q.Deferred<void>=Q.defer<void>();
    private timeout:number=0;
    public enterState(s: DeviceState) {
        if(s===this.state)
            return;
        console.log(this.cfg.url+" enterState: " + DeviceState[s] );
        this.state=s;
        switch(s) {
            case DeviceState.connecting:
                this.timeout=new Date().valueOf()+30*1000;
                this.eng.login(this.cfg.user, this.cfg.password).then(
                    () => {
                        this.enterState(DeviceState.startSubscr);
                    },
                    () => {
                        console.log("misslyckades att logga in till " + this.cfg.url);
                        this.enterState(DeviceState.fail);
                    }
                );
                break;
            case DeviceState.startSubscr:
                if (this.wantClose)
                    this.enterState(DeviceState.close)
                else {
                    this.tags.forEach(t=> t.startSubscr());
                    this.enterState(DeviceState.running);
                }
                break;
            case DeviceState.running:
                if(this.wantClose)
                    this.enterState(DeviceState.close)
                break;
            case DeviceState.fail:
                this.timeout = new Date().valueOf() + 30 * 1000;
                this.tags.forEach(t => t.endSubscr());
                this.eng.logout();
                if (this.wantClose)
                    this.enterState(DeviceState.closed)
                break;
            case DeviceState.close:
                this.tags.forEach(t => t.endSubscr());
                this.eng.logout().promise().then(()=>
                {
                    this.enterState(DeviceState.closed);
                })
            case DeviceState.closed:
                if (this.stream)
                    this.stream.close();
                this.stream = undefined;
                this.closedPromise.resolve();
                break;
        }
    }
    public doTimer() {
        let tid=new Date().valueOf();
        //this.eng.testTimeouts();
        switch (this.state) {
            case DeviceState.fail:
                if(tid>this.timeout)
                    this.enterState(DeviceState.connecting);
                break;
            case DeviceState.running:
                if(!this.eng.connectionOk()) {
                    console.log("connection not ok " + this.cfg.url);
                    this.enterState(DeviceState.fail);
                } else {
                    this.eng.testTimeouts();
                    let tic=new Date().valueOf();
                    this.tags.forEach(t=> t.doTimer(tic))
                }

        }
    }
    constructor(cfg:IDevice) {
        this.cfg=cfg;
        if(cfg.append??false)
            this.stream = fs.createWriteStream(cfg.filename, { flags: 'a', encoding: "utf8" });
        else
            this.stream = fs.createWriteStream(cfg.filename, { flags: 'w', encoding: "utf8" });
        this.eng = new kt.engine.KeyTalkEngine();
        this.eng.url=cfg.url;
        this.tags=cfg.tags.map(x=> new Tag(this,x));
        this.enterState(DeviceState.connecting);
    }
    public close():Q.Promise<void> {
        this.wantClose=true;

        if (this.state == DeviceState.fail || this.state == DeviceState.idle )
            this.enterState(DeviceState.closed);
        if(this.state==DeviceState.running)
            this.enterState(DeviceState.close);

        return this.closedPromise.promise;
    }
}

// --- Uppstart
console.log("Startar");
let indata: IConfigFile = JSON.parse(fs.readFileSync("config.json", 'utf8'));
let devices=indata.devices.map(d=> new Device(d));

let timer=setInterval(()=>{
    devices.forEach(d=>d.doTimer());
},1000);




// --- Hantering vid CTRL+C
if (process.platform === "win32") {
    var rl = require("readline").createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.on("SIGINT", function () {
        //@ts-ignore
        process.emit("SIGINT");
    });
}

process.on('SIGINT', function () {
    console.log("Avslutar...");
    clearInterval(timer);
    let closeProm = devices.map(d => d.close());
    Q.all(closeProm).then(() => {
        console.log("Allt stängt");
        process.exit();
    });
})

