export function WalletHeaderActions({native,onAbout}:{native:boolean;onAbout:()=>void}){
 return native
  ? <button type="button" className="stock-home" aria-haspopup="dialog" onClick={onAbout}>About</button>
  : <a className="stock-home" href="/">About</a>;
}

export function WalletBrand({native,onAbout}:{native:boolean;onAbout:()=>void}){
 return native
  ? <button type="button" className="stock-brand" aria-haspopup="dialog" onClick={onAbout}>Shielded<span>wallet</span></button>
  : <a className="stock-brand" href="/">Shielded<span>wallet</span></a>;
}
