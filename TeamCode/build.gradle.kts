plugins {
    id("dev.frozenmilk.teamcode") version "12.0.0-1.2.2"
    id("dev.frozenmilk.sinister.sloth.load") version "0.3.2"
}

ftc {
    kotlin()
    sdk.TeamCode()
    implementation(dairy.Sloth)
    implementation(dairy.slothboard(""))
}