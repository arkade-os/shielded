export function WalletHeaderActions({native,onAbout}:{native:boolean;onAbout:()=>void}){
 return native
  ? <button type="button" className="stock-home" aria-haspopup="dialog" onClick={onAbout}>About</button>
  : <a className="stock-home" href="/">About</a>;
}
