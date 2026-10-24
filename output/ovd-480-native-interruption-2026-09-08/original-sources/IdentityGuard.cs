using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
partial class TemporaryBoxes {
 static long ExpectedTicks;
 static int ExpectedSession;
 const string ExpectedHash="6384c0829bac149831be5fdc9e705c90612273d25b46fdff5e5760d11e22d6cc";
 static bool IdentityMatches(int pid,int session,long ticks,string hash,int expectedPid,int expectedSession,long expectedTicks){return pid==expectedPid && session==expectedSession && ticks==expectedTicks && hash==ExpectedHash;}
 static void GuardPredicateTests(int expected){
  if(expected!=5968 || ExpectedTicks<=0 || ExpectedSession!=Process.GetCurrentProcess().SessionId)throw new InvalidOperationException("Invalid expected identity");
  var tests=new Dictionary<string,bool>();Root["GuardPredicateTests"]=tests;
  tests["same_pass"]=IdentityMatches(expected,ExpectedSession,ExpectedTicks,ExpectedHash,expected,ExpectedSession,ExpectedTicks);
  tests["one_tick_change_rejected"]=!IdentityMatches(expected,ExpectedSession,ExpectedTicks+1,ExpectedHash,expected,ExpectedSession,ExpectedTicks);
  tests["pid_change_rejected"]=!IdentityMatches(expected+1,ExpectedSession,ExpectedTicks,ExpectedHash,expected,ExpectedSession,ExpectedTicks);
  tests["session_change_rejected"]=!IdentityMatches(expected,ExpectedSession+1,ExpectedTicks,ExpectedHash,expected,ExpectedSession,ExpectedTicks);
  tests["hash_change_rejected"]=!IdentityMatches(expected,ExpectedSession,ExpectedTicks,new string('0',64),expected,ExpectedSession,ExpectedTicks);
  foreach(bool pass in tests.Values)if(!pass)throw new InvalidOperationException("Guard predicate test failed");Log("after","local_guard_predicate_tests");
 }
 static void NativeIdentity(int expected,Dictionary<string,object> r,string label){
  Process[] ps=Process.GetProcessesByName("SLDWORKS");bool valid=false;
  try{if(ps.Length==1){Process p=ps[0];string path=p.MainModule.FileName;FileVersionInfo v=FileVersionInfo.GetVersionInfo(path);string hash;
   using(var f=File.OpenRead(path))using(var sha=SHA256.Create())hash=BitConverter.ToString(sha.ComputeHash(f)).Replace("-","").ToLowerInvariant();
   long ticks=p.StartTime.ToUniversalTime().Ticks;
   r[label]=new {PID=p.Id,Session=p.SessionId,StartTicks=ticks.ToString(),ExpectedTicks=ExpectedTicks.ToString(),SHA256=hash,Version=v.FileVersion};
   valid=IdentityMatches(p.Id,p.SessionId,ticks,hash,expected,ExpectedSession,ExpectedTicks) && expected==5968 && ExpectedSession==Process.GetCurrentProcess().SessionId && v.FileVersion=="30.5.0.0049" && v.ProductVersion=="30.5.0.0049";
  }}finally{foreach(Process p in ps)p.Dispose();}
  r[label+"Pass"]=valid;Log("after",label);if(!valid)throw new InvalidOperationException("Same-provider identity guard failed");
 }
}
