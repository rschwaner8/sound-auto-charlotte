const form=document.querySelector('#setup'),status=document.querySelector('#status');
form.addEventListener('submit',async e=>{
 e.preventDefault();const button=form.querySelector('button');button.disabled=true;status.textContent='Saving your password…';
 try{const response=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.querySelector('#token').value,password:document.querySelector('#password').value,confirm:document.querySelector('#confirm').value})});const result=await response.json();if(!response.ok)throw Error(result.error||'Setup failed');form.reset();form.hidden=true;status.textContent='Your admin login is ready. Use the sign-in link below. This setup form is now disabled.';}catch(error){status.textContent=error.message;button.disabled=false;}
});
