import Foundation
@main struct IdentityLogicTests {
 static func check(_ condition:Bool){precondition(condition)}
 static func main() throws {
  let a=AccountSession(accountID:"account-a",token:"first",appleUserID:"apple-a",expiresAt:Date().addingTimeInterval(1000))
  let refresh=AccountSession(accountID:"account-a",token:"next",appleUserID:"apple-a",expiresAt:Date().addingTimeInterval(1000))
  check(a.storageIdentity(origin:"https://test.invalid")==refresh.storageIdentity(origin:"https://test.invalid"))
  let b=AccountSession(accountID:"account-b",token:"second",appleUserID:"apple-b",expiresAt:Date().addingTimeInterval(1000))
  check(a.storageIdentity(origin:"https://test.invalid") != b.storageIdentity(origin:"https://test.invalid"))
  check(CredentialPersistencePolicy.maySaveDeveloperToken(mode:"local",accountID:nil))
  check(!CredentialPersistencePolicy.maySaveDeveloperToken(mode:"mock",accountID:"account-a"))
  check(!CredentialPersistencePolicy.maySaveDeveloperToken(mode:"local",accountID:"account-a"))
  check(!CredentialPersistencePolicy.maySaveDeveloperToken(mode:"service",accountID:"account-a"))
  let source=UUID().uuidString
  check(AgreementNotificationGate.accepted(sourceID:source,savedSources:[source]))
  check(!AgreementNotificationGate.accepted(sourceID:nil,savedSources:[source]))
  check(!AgreementNotificationGate.accepted(sourceID:UUID().uuidString,savedSources:[source]))
  let id=UUID().uuidString
  let notice=NotificationIntent(accountID:"account-a",notificationID:id)
  check(notice.canResolve(accountID:"account-a",connected:true));check(!notice.canResolve(accountID:"account-b",connected:true));check(!notice.canResolve(accountID:"account-a",connected:false))
  check(NotificationIntent.parse(["account_id":"account-a","notification_id":"fake"]) == nil)
  check(NotificationIntent.parse(["account_id":"account-a","notification_id":id]) == notice)
  let data=try JSONEncoder().encode(notice);check(try JSONDecoder().decode(NotificationIntent.self,from:data)==notice)
  let fp = String(repeating:"0123456789abcdef",count:4)
  let link = "maomao://pair?v=1&h=192.168.1.2,home.local&p=8788&c=abcd-1234&fp=" + fp
  let invitation = PairInvitation.parse(URL(string:link)!)!
  check(invitation.hosts == ["192.168.1.2","home.local"] && invitation.port == 8788 && invitation.code == "ABCD1234")
  check(PairInvitation.parse(URL(string:link.replacingOccurrences(of:"v=1",with:"v=2"))!) == nil)
  check(PairInvitation.parse(URL(string:link + "&v=1")!) == nil)
  check(PairInvitation.parse(URL(string:link.replacingOccurrences(of:"p=8788",with:"p=0"))!) == nil)
  check(PairInvitation.parse(URL(string:link.replacingOccurrences(of:"192.168.1.2",with:"bad/path"))!) == nil)
  check(PairInvitation.parse(URL(string:link.replacingOccurrences(of:fp,with:"bad"))!) == nil)
  check(!PairFingerprint.valid(String(repeating:"g",count:64)))
  check(!PairFingerprint.valid(String(repeating:"a",count:63)))
  check(PairFingerprint.short(fp) == "0123 4567 89ab cdef")
  check(PairFingerprint.short("") == "")
  let der = Data("证书样本".utf8)
  check(PairFingerprint.matches(der,pin:PairFingerprint.digest(der)))
  check(!PairFingerprint.matches(der,pin:fp))
  check(PairInvitation.address("home.local")?.port == 8788)
  check(PairInvitation.address("192.168.1.2:8789")?.port == 8789)
  check(PairInvitation.address("https://home.local") == nil)
  check(PairInvitation.normalizedCode("IIII-0000") == nil)
  let paired = PairedHost(hosts:["192.168.1.2","home.local"],port:8788,fingerprint:fp,deviceID:"phone",deviceToken:"secret",accountID:"owner")
  check(paired.storageIdentity == "paired:" + fp + "\nphone")
  check(paired.url(host:"home.local").absoluteString == "https://home.local:8788")
  print("手机配对逻辑：深链、地址、指纹格式与匹配、稳定分区检查通过")
  print("正式身份逻辑：会话轮换稳定分区、账号隔离、通知等待登录与真实ID检查通过")
 }
}
